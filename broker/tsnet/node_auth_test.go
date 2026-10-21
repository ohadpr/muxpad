package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

type fakeIdentity struct {
	who       *apitype.WhoIsResponse
	status    *ipnstate.Status
	err       error
	addr      string
	statusErr error
	wait      bool
}

func (f *fakeIdentity) WhoIs(ctx context.Context, addr string) (*apitype.WhoIsResponse, error) {
	if addr == "100.64.0.1" {
		return &apitype.WhoIsResponse{Node: &tailcfg.Node{StableID: "host", User: 42, Addresses: []netip.Prefix{netip.MustParsePrefix("100.64.0.1/32")}}, UserProfile: &tailcfg.UserProfile{ID: 42}}, nil
	}
	f.addr = addr
	if f.wait {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return f.who, f.err
}
func (f *fakeIdentity) Status(context.Context) (*ipnstate.Status, error) {
	return f.status, f.statusErr
}
func authFixture() (*nodeAuthority, *fakeIdentity, *nodePolicy) {
	raw := []byte(`{"version":1,"revision":"epoch1","hostNodeID":"host","brokerNodeID":"broker","tailnetID":"tailnet1","controlURL":"https://controlplane.tailscale.com","capability":"muxpad.org/cap/approve-member-v1"}`)
	p, e := parseNodePolicy(raw)
	if e != nil {
		panic(e)
	}
	f := &fakeIdentity{status: &ipnstate.Status{BackendState: "Running", Self: &ipnstate.PeerStatus{ID: "broker"}, CurrentTailnet: &ipnstate.TailnetStatus{StableID: "tailnet1"}, Peer: map[key.NodePublic]*ipnstate.PeerStatus{{}: {ID: "host"}}},
		who: &apitype.WhoIsResponse{Node: &tailcfg.Node{StableID: "phone", User: 42, Addresses: []netip.Prefix{netip.MustParsePrefix("100.64.0.2/32")}}, UserProfile: &tailcfg.UserProfile{ID: 42}, CapMap: tailcfg.PeerCapMap{"muxpad.org/cap/approve-member-v1": {tailcfg.RawMessage(`{}`)}}}}
	a := &nodeAuthority{interfaces: func() ([]net.Addr, error) {
		return []net.Addr{&net.IPNet{IP: net.ParseIP("100.64.0.1"), Mask: net.CIDRMask(32, 32)}}, nil
	}, client: f, self: "broker", load: func() (*nodePolicy, error) { return p, nil }}
	return a, f, p
}
func TestRemoteMemberProofAndExclusions(t *testing.T) {
	tests := []struct {
		name   string
		change func(*nodeAuthority, *fakeIdentity, *nodePolicy)
	}{
		{"host with capability", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.who.Node.StableID = "host" }},
		{"broker with capability", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.who.Node.StableID = "broker" }},
		{"wrong owner", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.who.UserProfile.ID = 43 }},
		{"shared", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.who.Node.Sharer = 43 }},
		{"tagged", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.who.Node.Tags = []string{"tag:server"} }},
		{"jailed", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.who.Node.IsJailed = true }},
		{"unsigned", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.who.Node.UnsignedPeerAPIOnly = true }},
		{"expired", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.who.Node.Expired = true }},
		{"key expiry", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) {
			f.who.Node.KeyExpiry = time.Now().Add(-time.Second)
		}},
		{"unknown", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.who = nil }},
		{"identity outage", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.err = errors.New("offline") }},
		{"status outage", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.statusErr = errors.New("offline") }},
		{"different tailnet", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.status.CurrentTailnet.StableID = "other" }},
		{"stale host exclusion", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.status.Peer = nil }},
		{"changed broker self", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.status.Self.ID = "newbroker" }},
		{"subnet origin", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) {
			f.who.Node.Addresses = []netip.Prefix{netip.MustParsePrefix("100.64.0.99/32")}
		}},
		{"absent capability", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) { f.who.CapMap = nil }},
		{"unknown capability version", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) {
			f.who.CapMap["muxpad.org/cap/approve-member-v1"] = []tailcfg.RawMessage{`{"version":2}`}
		}},
		{"multiple capability values", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) {
			f.who.CapMap["muxpad.org/cap/approve-member-v1"] = []tailcfg.RawMessage{`{}`, `{}`}
		}},
		{"null capability", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) {
			f.who.CapMap["muxpad.org/cap/approve-member-v1"] = []tailcfg.RawMessage{`null`}
		}},
		{"malformed capability", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) {
			f.who.CapMap["muxpad.org/cap/approve-member-v1"] = []tailcfg.RawMessage{`bad`}
		}},
		{"policy outage", func(a *nodeAuthority, f *fakeIdentity, p *nodePolicy) {
			a.load = func() (*nodePolicy, error) { return nil, errors.New("policy missing") }
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a, f, p := authFixture()
			tc.change(a, f, p)
			if got, e := a.verify(context.Background(), "100.64.0.2:5678"); e == nil || got != nil {
				t.Fatal("accepted", got, e)
			}
		})
	}
	for _, id := range []string{"phone", "new-same-owner-node"} {
		a, f, _ := authFixture()
		f.who.Node.StableID = tailcfg.StableNodeID(id)
		f.who.Node.Name = "renamed-device.example.ts.net."
		got, e := a.verify(context.Background(), "100.64.0.2:5678")
		if e != nil || got.NodeID != id || got.OwnerID != "42" || f.addr != "100.64.0.2:5678" {
			t.Fatal(got, e)
		}
	}
}
func TestWhoIsHonorsCancelledContext(t *testing.T) {
	a, f, _ := authFixture()
	f.wait = true
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := a.verify(ctx, "100.64.0.2:45"); e == nil {
		t.Fatal("accepted cancelled identity check")
	}
}
func TestProxyUsesOriginalPeerAndOverwritesHeaders(t *testing.T) {
	dir, e := os.MkdirTemp("/private/tmp", "mux-auth-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "b.sock")
	ln, e := net.Listen("unix", socket)
	if e != nil {
		t.Fatal(e)
	}
	seen := make(chan *http.Request, 3)
	backend := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { seen <- r; io.WriteString(w, "ok") })}
	go backend.Serve(ln)
	defer backend.Close()
	a, f, _ := authFixture()
	proxy := proxyHandler("https://secure.example.ts.net", socket, a)
	r := httptest.NewRequest("GET", "/human/session", nil)
	r.Host = "secure.example.ts.net"
	r.RemoteAddr = "100.64.0.2:5678"
	for _, name := range []string{peerHeader, "X-Muxpad-Verified-Owner", "X-Muxpad-Peer-Node", "Tailscale-User-Login", "X-Tailscale-Identity", "Forwarded", "X-Forwarded-For"} {
		r.Header.Add(name, "forged")
	}
	r.Header.Set("X-Muxpad-CSRF", "keep-csrf")
	w := httptest.NewRecorder()
	proxy.ServeHTTP(w, r)
	if w.Code != 200 || f.addr != "100.64.0.2:5678" {
		t.Fatal(w.Code, f.addr)
	}
	got := <-seen
	proof, e := a.verify(context.Background(), r.RemoteAddr)
	if e != nil {
		t.Fatal(e)
	}
	if got.Header.Get(peerHeader) != peerAssertion(proof) || len(got.Header.Values(peerHeader)) != 1 || got.Header.Get("X-Muxpad-CSRF") != "keep-csrf" {
		t.Fatal("bad transport proof")
	}
	for _, name := range []string{"X-Muxpad-Verified-Owner", "X-Muxpad-Peer-Node", "Tailscale-User-Login", "X-Tailscale-Identity", "Forwarded", "X-Forwarded-For"} {
		if got.Header.Get(name) != "" {
			t.Fatal("forwarded untrusted identity", name)
		}
	}
	f.who.Node.StableID = "host"
	r.Header.Set(peerHeader, peerAssertion(proof))
	w = httptest.NewRecorder()
	proxy.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("host forgery accepted", w.Code)
	}
	r.URL.Path = "/requests"
	w = httptest.NewRecorder()
	proxy.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal("machine queue blocked")
	}
	got = <-seen
	if got.Header.Get(peerHeader) != "" {
		t.Fatal("agent gained identity")
	}
}
func TestPrivateAuthorityRPCRevalidatesAndCannotChangeOwner(t *testing.T) {
	a, f, _ := authFixture()
	proof, e := a.verify(context.Background(), "100.64.0.2:12")
	if e != nil {
		t.Fatal(e)
	}
	check := func(p *verifiedNode) int {
		b, _ := json.Marshal(p)
		w := httptest.NewRecorder()
		a.checkHandler().ServeHTTP(w, httptest.NewRequest("POST", "/check", strings.NewReader(string(b))))
		return w.Code
	}
	if check(proof) != 200 {
		t.Fatal("valid proof refused")
	}
	proof.OwnerID = "99"
	if check(proof) != 403 {
		t.Fatal("owner substitution accepted")
	}
	proof.OwnerID = "42"
	f.who.CapMap = nil
	if check(proof) != 403 {
		t.Fatal("removed authority survives")
	}
}

func TestAuthoritySocketProtectionAndExistingListener(t *testing.T) {
	parent, e := filepath.EvalSymlinks(os.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	dir, e := os.MkdirTemp(parent, "ma-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(dir)
	os.Chmod(dir, 0700)
	path := filepath.Join(dir, "a.sock")
	ln, e := authorityListener(path)
	if e != nil {
		t.Fatal(e)
	}
	st, e := os.Stat(path)
	if e != nil || st.Mode().Perm() != 0600 {
		t.Fatal(st, e)
	}
	if second, e := authorityListener(path); e == nil {
		second.Close()
		t.Fatal("replaced active authority listener")
	}
	ln.Close()
	os.WriteFile(path, []byte("untouched"), 0600)
	if ln, e := authorityListener(path); e == nil {
		ln.Close()
		t.Fatal("replaced regular file")
	}
	b, _ := os.ReadFile(path)
	if string(b) != "untouched" {
		t.Fatal("modified unrelated file")
	}
	os.Remove(path)
	target := filepath.Join(dir, "target")
	os.WriteFile(target, []byte("untouched"), 0600)
	os.Symlink(target, path)
	if ln, e := authorityListener(path); e == nil {
		ln.Close()
		t.Fatal("followed authority symlink")
	}
	os.Remove(path)
	os.Chmod(dir, 0755)
	if ln, e := authorityListener(path); e == nil {
		ln.Close()
		t.Fatal("accepted public socket directory")
	}
}

func TestPolicyFaultAndRollbackNeverRestoreOldTransportAssertion(t *testing.T) {
	a, _, original := authFixture()
	old, e := a.verify(context.Background(), "100.64.0.2:12")
	if e != nil {
		t.Fatal(e)
	}
	a.load = func() (*nodePolicy, error) { return nil, errors.New("policy unavailable") }
	if _, e = a.verify(context.Background(), "100.64.0.2:12"); e == nil {
		t.Fatal("outage accepted")
	}
	a.load = func() (*nodePolicy, error) { return original, nil }
	fresh, e := a.verify(context.Background(), "100.64.0.2:12")
	if e != nil || old.Generation == fresh.Generation {
		t.Fatal("fault recovered old generation", fresh, e)
	}
	b, _ := json.Marshal(old)
	w := httptest.NewRecorder()
	a.checkHandler().ServeHTTP(w, httptest.NewRequest("POST", "/check", strings.NewReader(string(b))))
	if w.Code != 403 {
		t.Fatal("old assertion revived", w.Code)
	}
	raw, _ := json.Marshal(original)
	raw = []byte(strings.Replace(string(raw), "epoch1", "epoch2", 1))
	changed, e := parseNodePolicy(raw)
	if e != nil {
		t.Fatal(e)
	}
	a.load = func() (*nodePolicy, error) { return changed, nil }
	if _, e = a.verify(context.Background(), "100.64.0.2:12"); e != nil {
		t.Fatal(e)
	}
	a.load = func() (*nodePolicy, error) { return original, nil }
	if _, e = a.verify(context.Background(), "100.64.0.2:12"); e == nil {
		t.Fatal("retired root policy revived")
	}
}
func TestPolicyStrictScalarSchema(t *testing.T) {
	_, _, p := authFixture()
	b, _ := json.Marshal(p)
	raw := string(b)
	for _, bad := range []string{
		strings.Replace(raw, `"version":1`, `"Version":1`, 1),
		strings.Replace(raw, `"version":1`, `"version":1,"version":1`, 1),
		strings.Replace(raw, `"version":1`, `"version":1,"\u0076ersion":1`, 1),
		strings.Replace(raw, `"version":1`, `"version":1e0`, 1),
		strings.Replace(raw, `"revision":"epoch1"`, `"revision":{}`, 1),
		raw + `{}`, strings.Repeat(" ", 16385) + raw,
	} {
		if _, e := parseNodePolicy([]byte(bad)); e == nil {
			t.Fatal("accepted noncanonical schema", bad[:min(200, len(bad))])
		}
	}
}

func TestWhoIsDeadlineFailsClosed(t *testing.T) {
	a, f, _ := authFixture()
	f.wait = true
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, e := a.verify(ctx, "100.64.0.2:55"); e == nil {
		t.Fatal("timeout accepted")
	}
	if time.Since(started) > time.Second {
		t.Fatal("identity lookup ignored bounded context")
	}
}

func TestObservedPeerLossCannotReviveOldAssertion(t *testing.T) {
	for _, loss := range []string{"capability", "expired", "owner"} {
		t.Run(loss, func(t *testing.T) {
			a, f, _ := authFixture()
			old, e := a.verify(context.Background(), "100.64.0.2:12")
			if e != nil {
				t.Fatal(e)
			}
			caps := f.who.CapMap
			if loss == "capability" {
				f.who.CapMap = nil
			}
			if loss == "expired" {
				f.who.Node.Expired = true
			}
			if loss == "owner" {
				f.who.Node.User = 99
				f.who.UserProfile.ID = 99
			}
			if _, e = a.verify(context.Background(), "100.64.0.2:12"); e == nil {
				t.Fatal("lost authority accepted")
			}
			f.who.CapMap = caps
			f.who.Node.Expired = false
			f.who.Node.User = 42
			f.who.UserProfile.ID = 42
			b, _ := json.Marshal(old)
			w := httptest.NewRecorder()
			a.checkHandler().ServeHTTP(w, httptest.NewRequest("POST", "/check", strings.NewReader(string(b))))
			if w.Code != 403 {
				t.Fatal("restored old assertion", w.Code)
			}
			fresh, e := a.verify(context.Background(), "100.64.0.2:12")
			if e != nil || fresh.Generation == old.Generation {
				t.Fatal("generation not retired", fresh, e)
			}
		})
	}
}

type concurrentIdentity struct {
	base    *fakeIdentity
	mu      sync.Mutex
	calls   int
	entered chan struct{}
	release chan struct{}
}

func (f *concurrentIdentity) Status(ctx context.Context) (*ipnstate.Status, error) {
	return f.base.status, nil
}
func (f *concurrentIdentity) WhoIs(ctx context.Context, addr string) (*apitype.WhoIsResponse, error) {
	if addr == "100.64.0.1" {
		return f.base.WhoIs(ctx, addr)
	}
	f.mu.Lock()
	f.calls++
	call := f.calls
	f.mu.Unlock()
	node := *f.base.who.Node
	user := *f.base.who.UserProfile
	result := &apitype.WhoIsResponse{Node: &node, UserProfile: &user, CapMap: f.base.who.CapMap}
	if call == 2 {
		close(f.entered)
		select {
		case <-f.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if call == 3 {
		result.Node.Expired = true
	}
	return result, nil
}
func TestConcurrentStaleWhoIsCannotRestoreRetiredPeer(t *testing.T) {
	a, base, _ := authFixture()
	f := &concurrentIdentity{base: base, entered: make(chan struct{}), release: make(chan struct{})}
	a.client = f
	old, e := a.verify(context.Background(), "100.64.0.2:12")
	if e != nil {
		t.Fatal(e)
	}
	finished := make(chan error, 1)
	go func() { _, e := a.verify(context.Background(), "100.64.0.2:12"); finished <- e }()
	<-f.entered
	if _, e = a.verify(context.Background(), "100.64.0.2:12"); e == nil {
		t.Fatal("expiry accepted")
	}
	close(f.release)
	if e = <-finished; e == nil {
		t.Fatal("stale in-flight proof restored authority")
	}
	fresh, e := a.verify(context.Background(), "100.64.0.2:12")
	if e != nil || fresh.Generation == old.Generation {
		t.Fatal("old generation revived", fresh, e)
	}
}

func TestAuthorityRejectsHostnameBeforeLookupAndReassignedIP(t *testing.T) {
	a, f, _ := authFixture()
	if _, err := a.verify(context.Background(), "example.com:443"); err == nil || f.addr != "" {
		t.Fatal("hostname reached lookup")
	}
	proof, err := a.verify(context.Background(), "100.64.0.2")
	if err != nil {
		t.Fatal(err)
	}
	f.who.Node.StableID = "other-node"
	raw, _ := json.Marshal(proof)
	w := httptest.NewRecorder()
	a.checkHandler().ServeHTTP(w, httptest.NewRequest("POST", "/check", strings.NewReader(string(raw))))
	if w.Code != 403 {
		t.Fatal("reassigned address retained authority")
	}
}
func TestAuthorityRPCConcurrencyIsBounded(t *testing.T) {
	a, _, _ := authFixture()
	handler := a.checkHandler()
	entered := make(chan struct{}, 16)
	release := make(chan struct{})
	a.load = func() (*nodePolicy, error) { entered <- struct{}{}; <-release; return nil, errors.New("done") }
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/check", strings.NewReader(`{"nodeID":"phone","ownerID":"42","authorizationID":"rev","policy":"digest","ip":"100.64.0.2","generation":"gen"}`)))
		}()
	}
	for i := 0; i < 16; i++ {
		<-entered
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("POST", "/check", strings.NewReader("{}")))
	if w.Code != 503 {
		t.Fatal("unbounded RPC concurrency")
	}
	close(release)
	wg.Wait()
}
