package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

const pairedIdentitySocket = base + "/state/public-identity.sock"
const pairedIdentityVersion = "paired-bridge-v1-2026-10-19"

type pairedDiagnosticFailure string

func (e pairedDiagnosticFailure) Error() string { return string(e) }
func diag(code string) error                    { return pairedDiagnosticFailure(code) }

// Candidate metadata only. No policy, authority, state writes or approvals.
func discoverPairedIdentity(ctx context.Context, client identityClient, interfaces func() ([]net.Addr, error)) (*publicNodeIdentity, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	status, err := client.Status(ctx)
	if err != nil || status == nil {
		return nil, diag("DIAG_OWN_STATUS_LOOKUP")
	}
	if status.CurrentTailnet == nil || !identityPattern.MatchString(string(status.CurrentTailnet.StableID)) {
		return nil, diag("DIAG_TAILNET_ID_MISSING")
	}
	if status.BackendState != "Running" || status.Self == nil || status.Self.Expired || !identityPattern.MatchString(string(status.Self.ID)) {
		return nil, diag("DIAG_INITIAL_STATUS")
	}

	self := string(status.Self.ID)
	if len(status.Self.TailscaleIPs) == 0 || len(status.Self.TailscaleIPs) > 16 {
		return nil, diag("DIAG_BROKER_IPS_MISSING")
	}
	out := &publicNodeIdentity{BrokerNodeID: self, TailnetID: string(status.CurrentTailnet.StableID), BrokerIPs: []string{}}
	for _, ip := range status.Self.TailscaleIPs {
		if !ip.IsValid() || ip.Zone() != "" || (!tailnetV4.Contains(ip.Unmap()) && !tailnetV6.Contains(ip.Unmap())) {
			return nil, diag("DIAG_BROKER_IP_INVALID")
		}
		out.BrokerIPs = append(out.BrokerIPs, ip.Unmap().String())
	}
	raw, err := interfaces()
	if err != nil {
		return nil, diag("DIAG_KERNEL_INTERFACES")
	}
	ips, err := hostCandidates(raw)
	if err != nil {
		return nil, diag("DIAG_HOST_CANDIDATES")
	}
	owner := int64(0)
	for _, ip := range ips {
		if ctx.Err() != nil {
			return nil, diag("DIAG_CANCELLED")
		}
		who, err := client.WhoIs(ctx, ip.String())
		if err != nil || who == nil || who.Node == nil || who.UserProfile == nil {
			return nil, diag("DIAG_HOST_LOOKUP")
		}
		// This is public exclusion-candidate identity, not approval authority.
		// WhoIs peers need not carry MachineAuthorized=true (a self-status
		// field, plain omitempty bool). Never infer console approval from it.
		n := who.Node
		checks := []struct {
			bad  bool
			code string
		}{
			{!identityPattern.MatchString(string(n.StableID)), "DIAG_HOST_ID"},
			{string(n.StableID) == self, "DIAG_HOST_IS_SELF"},
			{n.User <= 0 || n.User != who.UserProfile.ID, "DIAG_HOST_OWNER"},
			{n.Sharer != 0, "DIAG_HOST_SHARED"}, {n.IsTagged(), "DIAG_HOST_TAGGED"},
			{n.IsJailed, "DIAG_HOST_JAILED"}, {n.Expired || (!n.KeyExpiry.IsZero() && !n.KeyExpiry.After(time.Now())), "DIAG_HOST_EXPIRED"},
			{n.UnsignedPeerAPIOnly, "DIAG_HOST_UNSIGNED"}, {n.IsWireGuardOnly, "DIAG_HOST_WIREGUARD"},
		}
		for _, check := range checks {
			if check.bad {
				return nil, diag(check.code)
			}
		}

		direct := false
		for _, p := range n.Addresses {
			if p.IsSingleIP() && p.Addr().Unmap() == ip {
				direct = true
			}
		}
		if !direct {
			return nil, diag("DIAG_HOST_NOT_DIRECT")
		}
		if (out.HostNodeID != "" && out.HostNodeID != string(n.StableID)) || (owner != 0 && owner != int64(n.User)) {
			return nil, diag("DIAG_HOST_CONFLICT")
		}

		out.HostNodeID = string(n.StableID)
		owner = int64(n.User)
	}
	// Re-read own context after awaited discovery; no policy assumptions.
	final, err := client.Status(ctx)
	if err != nil || ctx.Err() != nil || final == nil || final.BackendState != "Running" || final.Self == nil || final.Self.Expired || string(final.Self.ID) != self || final.CurrentTailnet == nil || string(final.CurrentTailnet.StableID) != out.TailnetID {
		return nil, diag("DIAG_FINAL_CONTEXT")
	}
	if len(final.Self.TailscaleIPs) != len(status.Self.TailscaleIPs) {
		return nil, diag("DIAG_BROKER_IP_CHANGED")
	}
	for i, ip := range final.Self.TailscaleIPs {
		if ip != status.Self.TailscaleIPs[i] {
			return nil, diag("DIAG_BROKER_IP_CHANGED")
		}
	}
	return out, nil
}
func pairedIdentityHandler(client identityClient, interfaces func() ([]net.Addr, error)) http.Handler {
	slots := make(chan struct{}, 16)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/identity" || r.URL.RawQuery != "" || r.URL.ForceQuery || r.ContentLength != 0 || len(r.TransferEncoding) != 0 {
			http.Error(w, "refused", 404)
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			writePairedDiagnosticFailure(w, "DIAG_BUSY")
			return
		}
		out, err := discoverPairedIdentity(r.Context(), client, interfaces)
		if err != nil {
			var failure pairedDiagnosticFailure
			if errors.As(err, &failure) {
				writePairedDiagnosticFailure(w, string(failure))
			} else {
				writePairedDiagnosticFailure(w, "DIAG_INTERNAL")
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Muxpad-Diagnostic-Version", pairedIdentityVersion)
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(out)
	})
}

// Separate metadata-only lifecycle: no authorityDone propagation to paired child.
func startPairedDiagnostic(client identityClient, interfaces func() ([]net.Addr, error), listen func() (net.Listener, error), report func()) *http.Server {
	ln, err := listen()
	if err != nil {
		report()
		return nil
	}
	srv := &http.Server{Handler: pairedIdentityHandler(client, interfaces), ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 2 * time.Second, WriteTimeout: 3 * time.Second, MaxHeaderBytes: 4096}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			report()
		}
	}()
	return srv
}
func pairedIdentityListener(path string) (net.Listener, error) {
	if err := privateDirectory(filepath.Dir(path)); err != nil {
		return nil, err
	}
	if st, err := os.Lstat(path); err == nil {
		owner, ok := st.Sys().(*syscall.Stat_t)
		if !ok || st.Mode()&os.ModeSocket == 0 || st.Mode().Perm() != 0600 || int(owner.Uid) != os.Getuid() {
			return nil, errors.New("unsafe diagnostic socket")
		}
		conn, dialErr := net.DialTimeout("unix", path, 100*time.Millisecond)
		if dialErr == nil {
			conn.Close()
			return nil, errors.New("diagnostic already active")
		}
		// Only positively refused stale sockets can be replaced, never timeout/errors.
		if !errors.Is(dialErr, syscall.ECONNREFUSED) {
			return nil, errors.New("diagnostic socket uncertain")
		}
		now, e := os.Lstat(path)
		if e != nil || !os.SameFile(st, now) {
			return nil, errors.New("diagnostic socket changed")
		}
		if e = os.Remove(path); e != nil {
			return nil, e
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(path, 0600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

func writePairedDiagnosticFailure(w http.ResponseWriter, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}
