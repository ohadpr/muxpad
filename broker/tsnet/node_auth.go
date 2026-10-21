package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
)

const nodePolicyPath = base + "/node-policy.json"
const authoritySocket = base + "/state/authority.sock"
const peerHeader = "X-Muxpad-Verified-Peer"

type nodePolicy struct {
	Version      int    `json:"version"`
	Revision     string `json:"revision"`
	HostNodeID   string `json:"hostNodeID"`
	BrokerNodeID string `json:"brokerNodeID"`
	TailnetID    string `json:"tailnetID"`
	ControlURL   string `json:"controlURL"`
	Capability   string `json:"capability"`
	digest       string
}
type verifiedNode struct {
	Generation      string `json:"generation"`
	NodeID          string `json:"nodeID"`
	OwnerID         string `json:"ownerID"`
	AuthorizationID string `json:"authorizationID"`
	Policy          string `json:"policy"`
	IP              string `json:"ip"`
}

var identityPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var ownerPattern = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)

func strictScalars(raw []byte, fields []string, version bool) error {
	if len(raw) > 16384 {
		return errors.New("oversized identity object")
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("identity object required")
	}
	allowed := map[string]bool{}
	seen := map[string]bool{}
	for _, key := range fields {
		allowed[key] = true
	}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		key, ok := token.(string)
		if !ok || !allowed[key] || seen[key] {
			return errors.New("unknown or duplicate identity field")
		}
		seen[key] = true
		var value json.RawMessage
		if err = decoder.Decode(&value); err != nil {
			return err
		}
		if version && key == "version" {
			if strings.TrimSpace(string(value)) != "1" {
				return errors.New("invalid identity version")
			}

		} else {
			var s string
			if err = json.Unmarshal(value, &s); err != nil || string(value) == "null" {
				return errors.New("identity string required")
			}
		}
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') || len(seen) != len(allowed) {
		return errors.New("incomplete identity object")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("trailing identity data")
	}
	return nil
}
func parseNodePolicy(raw []byte) (*nodePolicy, error) {
	var p nodePolicy
	if err := strictScalars(raw, []string{"version", "revision", "hostNodeID", "brokerNodeID", "tailnetID", "controlURL", "capability"}, true); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.Version != 1 || !identityPattern.MatchString(p.Revision) || !identityPattern.MatchString(p.HostNodeID) || !identityPattern.MatchString(p.BrokerNodeID) || p.HostNodeID == p.BrokerNodeID || !identityPattern.MatchString(p.TailnetID) || p.ControlURL != "https://controlplane.tailscale.com" || p.Capability != "muxpad.org/cap/approve-member-v1" {
		return nil, errors.New("invalid node policy")
	}

	sum := sha256.Sum256(raw)
	p.digest = hex.EncodeToString(sum[:])
	return &p, nil
}

// Root ownership, no links/writable ancestors/ACLs. No installed state is read by tests.
func rootFile(path string) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("absolute root path required")
	}
	for current := filepath.Clean(path); ; current = filepath.Dir(current) {
		st, err := os.Lstat(current)
		if err != nil {
			return nil, err
		}
		owner, ok := st.Sys().(*syscall.Stat_t)
		if !ok || owner.Uid != 0 || st.Mode().Perm()&0022 != 0 || st.Mode()&os.ModeSymlink != 0 || (current != path && !st.IsDir()) {
			return nil, errors.New("unprotected root policy")
		}
		if current == path && (!st.Mode().IsRegular() || owner.Nlink != 1 || st.Mode().Perm() != 0644) {
			return nil, errors.New("invalid root file")
		}
		cmd := exec.Command("/bin/ls", "-lde", current)
		cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL=C"}
		acl, err := cmd.Output()
		if err != nil {
			return nil, err
		}
		if regexp.MustCompile(`(?m)^\s*\d+:`).Match(acl) {
			return nil, errors.New("ACL on root policy")
		}
		if current == "/" {
			break
		}
	}
	return os.ReadFile(path)
}

type identityClient interface {
	WhoIs(context.Context, string) (*apitype.WhoIsResponse, error)
	Status(context.Context) (*ipnstate.Status, error)
}
type nodeAuthority struct {
	interfaces     func() ([]net.Addr, error)
	hostProof      string
	mu             sync.Mutex
	generation     string
	observedPolicy string
	retired        map[string]bool
	authorized     map[string]string
	client         identityClient
	self           string
	load           func() (*nodePolicy, error)
}

func (a *nodeAuthority) policyGeneration(digest string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.retired[digest] {
		return "", errors.New("retired policy generation")
	}
	if a.observedPolicy != "" && a.observedPolicy != digest {
		if len(a.retired) >= 256 {
			return "", errors.New("policy generation history requires reconciliation")
		}
		if a.retired == nil {
			a.retired = make(map[string]bool)
		}
		a.retired[a.observedPolicy] = true
		a.generation = rand.Text()
		a.authorized = nil
	}
	a.observedPolicy = digest
	if a.generation == "" {
		a.generation = rand.Text()
	}
	return a.generation, nil
}
func (a *nodeAuthority) identityFault() { a.mu.Lock(); a.generation = rand.Text(); a.mu.Unlock() }
func (a *nodeAuthority) peerLost(node string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.authorized[node] != "" {
		a.generation = rand.Text()
		delete(a.authorized, node)
	}
}
func (a *nodeAuthority) authorizeGeneration(generation, digest, node, owner string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.generation != generation || a.observedPolicy != digest || a.retired[digest] {
		return false
	}
	if a.authorized == nil {
		a.authorized = make(map[string]string)
	}
	if previous := a.authorized[node]; previous != "" && previous != owner {
		a.generation = rand.Text()
		a.authorized[node] = owner
		return false
	}
	if a.authorized[node] == "" && len(a.authorized) >= 256 {
		return false
	}
	a.authorized[node] = owner
	return true
}

func (a *nodeAuthority) verify(ctx context.Context, addr string) (*verifiedNode, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	ip, err := netip.ParseAddr(addr)
	if err != nil {
		ap, e := netip.ParseAddrPort(addr)
		if e != nil {
			return nil, errors.New("invalid source address")
		}
		ip = ap.Addr()
	}
	ip = ip.Unmap()
	p, err := a.load()
	if err != nil {
		a.identityFault()
		return nil, err
	}
	generation, err := a.policyGeneration(p.digest)
	if err != nil {
		return nil, err
	}
	if p.BrokerNodeID != a.self {
		return nil, errors.New("broker identity changed")
	}
	// A stale hosting-node exclusion is unsafe: do not accept other peers when
	// the pinned host has disappeared from this helper's current netmap.
	status, err := a.client.Status(ctx)
	if err != nil || status == nil || status.BackendState != "Running" || status.Self == nil || status.Self.Expired || string(status.Self.ID) != a.self || status.CurrentTailnet == nil || string(status.CurrentTailnet.StableID) != p.TailnetID {
		a.identityFault()
		return nil, errors.New("identity status unavailable")
	}
	hostPresent := false
	for _, peer := range status.Peer {
		if peer != nil && string(peer.ID) == p.HostNodeID && !peer.Expired {
			hostPresent = true
		}
	}
	if !hostPresent {
		a.identityFault()
		return nil, errors.New("hosting identity requires reconciliation")
	}
	if err := a.verifyHost(ctx, p, status, generation); err != nil {
		a.identityFault()
		return nil, err
	}
	who, err := a.client.WhoIs(ctx, addr)
	if err != nil || who == nil || who.Node == nil || who.UserProfile == nil {
		a.identityFault()
		return nil, errors.New("source identity unavailable")
	}
	n := who.Node
	if n.StableID == "" || n.User <= 0 || n.User != who.UserProfile.ID || n.Sharer != 0 || n.IsTagged() || n.IsJailed || n.UnsignedPeerAPIOnly || n.IsWireGuardOnly || n.Expired || (!n.KeyExpiry.IsZero() && !n.KeyExpiry.After(time.Now())) {
		a.peerLost(string(n.StableID))
		return nil, errors.New("unsupported source identity")
	}
	node, owner := string(n.StableID), strconv.FormatInt(int64(n.User), 10)
	if node == p.HostNodeID || node == p.BrokerNodeID {
		return nil, errors.New("hosting node cannot approve")
	}
	// Reject subnet-origin addresses: WhoIs must identify this node's OWN IP.
	direct := false
	for _, prefix := range n.Addresses {
		if prefix.Addr().Unmap() == ip {
			direct = true
		}
	}
	if !direct {
		a.peerLost(node)
		return nil, errors.New("indirect source is not a private node")
	}

	values := who.CapMap["muxpad.org/cap/approve-member-v1"]
	var parameters map[string]json.RawMessage
	if len(values) != 1 || json.Unmarshal([]byte(values[0]), &parameters) != nil || parameters == nil || len(parameters) != 0 {
		a.peerLost(node)
		return nil, errors.New("valid member capability required")
	}

	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !a.authorizeGeneration(generation, p.digest, node, owner) {
		return nil, errors.New("identity generation changed")
	}
	return &verifiedNode{Generation: generation, NodeID: node, OwnerID: owner, AuthorizationID: p.Revision, Policy: p.digest, IP: ip.String()}, nil
}
func stripIdentityHeaders(r *http.Request) {
	for k := range r.Header {
		lower := strings.ToLower(k)
		if (strings.HasPrefix(lower, "x-muxpad-") && lower != "x-muxpad-csrf") || strings.HasPrefix(lower, "tailscale-") || strings.HasPrefix(lower, "x-tailscale-") || lower == "forwarded" || strings.HasPrefix(lower, "x-forwarded-") {
			delete(r.Header, k)
		}
	}
}

// This listener is inaccessible to the ordinary hosting UID. It can only
// revalidate an existing assertion, never create a browser session/decision.
func (a *nodeAuthority) checkHandler() http.Handler {
	slots := make(chan struct{}, 16)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !((r.Method == "POST" && r.URL.Path == "/check") || (r.Method == "GET" && r.URL.Path == "/identity" && r.ContentLength == 0 && len(r.TransferEncoding) == 0)) {
			http.Error(w, "refused", 404)
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			http.Error(w, "busy", 503)
			return
		}
		if r.URL.Path == "/identity" {
			identity, err := a.publicIdentity(r.Context())
			if err != nil {
				http.Error(w, "identity unavailable", 503)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(identity)
			return
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, 4097))
		var want verifiedNode
		if err != nil || len(raw) > 4096 || strictScalars(raw, []string{"nodeID", "ownerID", "authorizationID", "policy", "ip", "generation"}, false) != nil || json.Unmarshal(raw, &want) != nil {
			http.Error(w, "refused", 403)
			return
		}
		got, err := a.verify(r.Context(), want.IP)
		if err != nil || *got != want {
			http.Error(w, "refused", 403)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(got)
	})
}
func authorityListener(path string) (net.Listener, error) {
	if err := privateDirectory(filepath.Dir(path)); err != nil {
		return nil, err
	}
	if st, err := os.Lstat(path); err == nil {
		owner, ok := st.Sys().(*syscall.Stat_t)
		if !ok || st.Mode()&os.ModeSocket == 0 || int(owner.Uid) != os.Getuid() || st.Mode().Perm()&0077 != 0 {
			return nil, errors.New("unexpected authority socket")
		}
		if conn, dialErr := net.DialTimeout("unix", path, 100*time.Millisecond); dialErr == nil {
			conn.Close()
			return nil, errors.New("authority socket already active")
		}
		if err = os.Remove(path); err != nil {
			return nil, err
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
func peerAssertion(p *verifiedNode) string {
	b, _ := json.Marshal(p)
	return base64.RawURLEncoding.EncodeToString(b)
}
func loadNodePolicy() (*nodePolicy, error) {
	b, e := rootFile(nodePolicyPath)
	if e != nil {
		return nil, e
	}
	return parseNodePolicy(b)
}
func configuredAuthMode() (string, error) {
	b, e := rootFile(base + "/config.json")
	if e != nil {
		return "", e
	}
	var c struct {
		AuthMode     string `json:"authMode"`
		Transport    string `json:"transport"`
		ApprovalMode string `json:"approvalMode"`
	}
	if e = json.Unmarshal(b, &c); e != nil {
		return "", e
	}
	switch c.AuthMode {
	case "", "paired":
		return "paired", nil
	case "tailnet-peer":
		if c.Transport == "tsnet" && c.ApprovalMode == "session" {
			return c.AuthMode, nil
		}
	}
	return "", fmt.Errorf("invalid authentication mode")
}
