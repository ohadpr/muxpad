// The only network listener is an independent, private tsnet HTTPS endpoint.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

const base = "/Library/muxpad-broker"
const socketPath = base + "/state/broker.sock"

func validDNS(name string) bool {
	if name != strings.ToLower(name) || !strings.HasSuffix(name, ".ts.net") || len(name) > 253 {
		return false
	}
	labels := strings.Split(name, ".")
	if len(labels) < 4 {
		return false
	}
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	return true
}

func privateDirectory(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("private path must be absolute")
	}
	for current := filepath.Clean(path); ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || (int(st.Uid) != 0 && int(st.Uid) != os.Getuid()) || info.Mode().Perm()&0022 != 0 {
			return errors.New("unprotected directory or ancestor")
		}
		if current == path && (info.Mode().Perm() != 0700 || int(st.Uid) != os.Getuid()) {
			return errors.New("state directory is not private to broker UID")
		}
		command := exec.Command("/bin/ls", "-lde", current)
		command.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL=C"}
		acl, err := command.Output()
		if err != nil {
			return err
		}
		if regexp.MustCompile(`(?m)^\s*\d+:`).Match(acl) {
			return errors.New("ACL on private state or ancestor")
		}
		if current == "/" {
			return nil
		}
	}
}

func writeOrigin(path, origin string) error {
	// Exclusive unique file, atomic rename; never follow an existing origin symlink.
	f, err := os.CreateTemp(filepath.Dir(path), ".origin-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.WriteString(origin)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}

type peerContextKey struct{}

func proxyHandler(origin, socket string, authorities ...*nodeAuthority) http.Handler {
	var authority *nodeAuthority
	if len(authorities) == 1 {
		authority = authorities[0]
	}
	target := &url.URL{Scheme: "http", Host: "broker.internal"}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", socket)
		},
		ResponseHeaderTimeout:  20 * time.Second,
		MaxResponseHeaderBytes: 64 << 10,
	}
	// Prevent ReverseProxy from logging credential-bearing requests or headers.
	proxy.ErrorLog = log.New(os.Stderr, "broker unavailable: ", 0)
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, _ error) {
		http.Error(w, "Protected broker unavailable", http.StatusBadGateway)
	}
	expected := strings.TrimPrefix(origin, "https://")
	director := proxy.Director
	proxy.Director = func(r *http.Request) {
		director(r)
		r.Host = expected
		stripIdentityHeaders(r)
		if peer, ok := r.Context().Value(peerContextKey{}).(*verifiedNode); ok {
			r.Header.Set(peerHeader, peerAssertion(peer))
		}
		r.Header.Del("Forwarded")
		r.Header.Del("X-Forwarded-Host")
		r.Header.Del("X-Forwarded-Proto")
		r.Header["X-Forwarded-For"] = nil
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != expected || r.URL.IsAbs() || r.Method == http.MethodConnect {
			http.Error(w, "Wrong host", http.StatusMisdirectedRequest)
			return
		}
		if authority != nil && (strings.HasPrefix(r.URL.Path, "/human/") || strings.HasPrefix(r.URL.Path, "/device/")) {
			peer, err := authority.verify(r.Context(), r.RemoteAddr)
			if err != nil {
				http.Error(w, "This device cannot authorize approvals", http.StatusForbidden)
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), peerContextKey{}, peer))
		}
		proxy.ServeHTTP(w, r)
	})
}

func run() error {
	enroll := flag.Bool("enroll-only", false, "Authorize the independent node, then exit")
	version := flag.Bool("version", false, "Print build identity without starting networking")
	flag.Parse()
	if *version {
		fmt.Println("muxpad tsnet member-v1 / tailscale v1.104.1")
		return nil
	}
	if flag.NArg() != 0 || os.Getuid() == 0 {
		return errors.New("run as the dedicated broker UID without positional arguments")
	}
	if err := privateDirectory(base + "/state"); err != nil {
		return err
	}
	state := base + "/state/tailscale"
	if err := os.Mkdir(state, 0700); err != nil && !os.IsExist(err) {
		return err
	}
	if err := privateDirectory(state); err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	mode := "paired"
	if !*enroll {
		var err error
		mode, err = configuredAuthMode()
		if err != nil {
			return err
		}
	}
	srv := &tsnet.Server{Dir: state, Hostname: "muxpad-secure", Logf: func(string, ...any) {}, UserLogf: log.Printf}
	if mode == "tailnet-peer" {
		p, err := loadNodePolicy()
		if err != nil {
			return err
		}
		srv.ControlURL = p.ControlURL
	}
	defer srv.Close()
	status, err := srv.Up(ctx)
	if err != nil {
		return err
	}
	if status.Self == nil {
		return errors.New("missing independent tailnet identity")
	}
	name := strings.TrimSuffix(status.Self.DNSName, ".")
	if !validDNS(name) {
		return errors.New("invalid assigned tailnet hostname")
	}
	origin := "https://" + name
	if err := writeOrigin(base+"/state/origin", origin); err != nil {
		return err
	}
	if *enroll {
		fmt.Println("Private muxpad URL: " + origin)
		return nil
	}
	var authority *nodeAuthority
	var authorityDone chan error
	if mode == "tailnet-peer" {
		lc, err := srv.LocalClient()
		if err != nil {
			return err
		}
		authority = &nodeAuthority{client: lc, self: string(status.Self.ID), load: loadNodePolicy}
		policy, err := authority.load()
		if err != nil {
			return err
		}
		if policy.BrokerNodeID != authority.self {
			return errors.New("configured broker identity mismatch")
		}
		// Verify actual OS host BEFORE authority listener, child and HTTPS.
		proofCtx, proofCancel := context.WithTimeout(ctx, 2*time.Second)
		generation, proofErr := authority.policyGeneration(policy.digest)
		if proofErr == nil {
			proofErr = authority.verifyHost(proofCtx, policy, status, generation)
		}
		proofCancel()
		if proofErr != nil {
			return proofErr
		}
		listener, err := authorityListener(authoritySocket)
		if err != nil {
			return err
		}
		authorityServer := &http.Server{Handler: authority.checkHandler(), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 3 * time.Second, WriteTimeout: 5 * time.Second, MaxHeaderBytes: 4096}
		defer authorityServer.Close()
		authorityDone = make(chan error, 1)
		go func() { authorityDone <- authorityServer.Serve(listener) }()
	}
	// Diagnostic failure must never take down existing paired authority.
	if mode == "paired" {
		lc, err := srv.LocalClient()
		if err != nil {
			log.Print("Paired diagnostic disabled: LocalClient unavailable")
		} else {
			diagnostic := startPairedDiagnostic(lc, net.InterfaceAddrs, func() (net.Listener, error) { return pairedIdentityListener(pairedIdentitySocket) }, func() { log.Print("Paired diagnostic unavailable; paired approvals unchanged") })
			if diagnostic != nil {
				defer diagnostic.Close()
			}
		}
	}
	// The installer supplies a pinned root-controlled Node runtime, not PATH.
	child := exec.Command(base+"/runtime/node", base+"/code/main.mjs", base+"/config.json")
	child.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=/var/empty"}
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	if err := child.Start(); err != nil {
		return err
	}

	childDone := make(chan error, 1)
	go func() { childDone <- child.Wait() }()
	childExited := false
	defer func() {
		if childExited {
			return
		}
		_ = child.Process.Signal(syscall.SIGTERM)
		select {
		case <-childDone:
		case <-time.After(5 * time.Second):
			_ = child.Process.Kill()
			<-childDone
		}
	}()

	ln, err := srv.ListenTLS("tcp", ":443")
	if err != nil {
		return err
	}
	httpServer := &http.Server{Handler: proxyHandler(origin, socketPath, authority), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 64 << 10}
	serverDone := make(chan error, 1)
	go func() { serverDone <- httpServer.Serve(ln) }()
	fmt.Println("Protected muxpad ready at " + origin)
	select {
	case <-ctx.Done():
		shutdownCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = httpServer.Shutdown(shutdownCtx)

		return nil
	case err := <-childDone:
		childExited = true
		_ = httpServer.Close()
		if err == nil {
			return errors.New("broker exited")
		}
		return err
	case err := <-authorityDone:
		_ = httpServer.Close()
		return err
	case err := <-serverDone:
		return err
	}
}
func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
