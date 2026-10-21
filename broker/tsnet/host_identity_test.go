package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"testing"
	"time"
)

type interfaceAddr string

func (a interfaceAddr) Network() string { return "ip" }
func (a interfaceAddr) String() string  { return string(a) }

type hostIdentityClient struct {
	base    *fakeIdentity
	records map[string]*apitype.WhoIsResponse
	wait    bool
}

func (f *hostIdentityClient) Status(ctx context.Context) (*ipnstate.Status, error) {
	return f.base.Status(ctx)
}
func (f *hostIdentityClient) WhoIs(ctx context.Context, addr string) (*apitype.WhoIsResponse, error) {
	if r, ok := f.records[addr]; ok {
		if f.wait {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return r, nil
	}
	if addr == "100.64.0.2:12" || addr == "100.64.0.2" {
		return f.base.WhoIs(ctx, addr)
	}
	return nil, errors.New("unknown interface address")
}
func hostRecord(id, ip string) *apitype.WhoIsResponse {
	return &apitype.WhoIsResponse{Node: &tailcfg.Node{StableID: tailcfg.StableNodeID(id), User: 42,
		Addresses: []netip.Prefix{netip.PrefixFrom(netip.MustParseAddr(ip), netip.MustParseAddr(ip).BitLen())}},
		UserProfile: &tailcfg.UserProfile{ID: 42}}
}
func TestHostProofCandidatesAndDirectIdentity(t *testing.T) {
	for _, tc := range []struct {
		name   string
		ips    []net.Addr
		change func(*hostIdentityClient)
		valid  bool
	}{
		{"dedup dualstack same node", []net.Addr{interfaceAddr("100.64.0.1/32"), interfaceAddr("100.64.0.1"), interfaceAddr("fd7a:115c:a1e0::1/128")}, nil, true},
		{"no tailnet interface", []net.Addr{interfaceAddr("127.0.0.1/8")}, nil, false},
		{"wrong actual host", []net.Addr{interfaceAddr("100.64.0.1/32")}, func(f *hostIdentityClient) { f.records["100.64.0.1"].Node.StableID = "other" }, false},
		{"overlap VPN unresolved", []net.Addr{interfaceAddr("100.64.0.1/32"), interfaceAddr("100.100.0.2/32")}, nil, false},
		{"two different identities", []net.Addr{interfaceAddr("100.64.0.1/32"), interfaceAddr("fd7a:115c:a1e0::1/128")}, func(f *hostIdentityClient) { f.records["fd7a:115c:a1e0::1"].Node.StableID = "different" }, false},
		{"subnet attribution", []net.Addr{interfaceAddr("100.64.0.1/24")}, func(f *hostIdentityClient) {
			f.records["100.64.0.1"].Node.Addresses = []netip.Prefix{netip.MustParsePrefix("100.64.0.0/24")}
		}, false},
		{"host expiry", []net.Addr{interfaceAddr("100.64.0.1/32")}, func(f *hostIdentityClient) { f.records["100.64.0.1"].Node.Expired = true }, false},
		{"owner mismatch", []net.Addr{interfaceAddr("100.64.0.1/32")}, func(f *hostIdentityClient) { f.records["100.64.0.1"].UserProfile.ID = 43 }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, base, _ := authFixture()
			f := &hostIdentityClient{base: base, records: map[string]*apitype.WhoIsResponse{"100.64.0.1": hostRecord("host", "100.64.0.1"), "fd7a:115c:a1e0::1": hostRecord("host", "fd7a:115c:a1e0::1")}}
			a.client = f
			a.interfaces = func() ([]net.Addr, error) { return tc.ips, nil }
			if tc.change != nil {
				tc.change(f)
			}
			_, err := a.verify(context.Background(), "100.64.0.2:12")
			if (err == nil) != tc.valid {
				t.Fatal("wrong host proof outcome", err)
			}
		})
	}
}
func TestHostProofTimeoutAndInterfaceRecoveryRetireOldGeneration(t *testing.T) {
	a, base, _ := authFixture()
	f := &hostIdentityClient{base: base, records: map[string]*apitype.WhoIsResponse{"100.64.0.1": hostRecord("host", "100.64.0.1")}}
	a.client = f
	old, err := a.verify(context.Background(), "100.64.0.2:12")
	if err != nil {
		t.Fatal(err)
	}
	f.wait = true
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := a.verify(ctx, "100.64.0.2:12"); err == nil {
		t.Fatal("hanging host check admitted")
	}
	f.wait = false
	fresh, err := a.verify(context.Background(), "100.64.0.2:12")
	if err != nil || fresh.Generation == old.Generation {
		t.Fatal("restored old generation", err)
	}
	raw, _ := json.Marshal(old)
	w := httptest.NewRecorder()
	a.checkHandler().ServeHTTP(w, httptest.NewRequest("POST", "/check", strings.NewReader(string(raw))))
	if w.Code != 403 {
		t.Fatal("original assertion survived host failure")
	}
	ips := []net.Addr{interfaceAddr("100.64.0.1/32"), interfaceAddr("fd7a:115c:a1e0::1/128")}
	f.records["fd7a:115c:a1e0::1"] = hostRecord("host", "fd7a:115c:a1e0::1")
	a.interfaces = func() ([]net.Addr, error) { return ips, nil }
	if _, err := a.verify(context.Background(), "100.64.0.2:12"); err == nil {
		t.Fatal("interface change not invalidated")
	}
	if _, err := a.verify(context.Background(), "100.64.0.2:12"); err != nil {
		t.Fatal(err)
	}
	f.records["100.64.0.1"] = hostRecord("reenrolled-host", "100.64.0.1")
	if _, err := a.verify(context.Background(), "100.64.0.2:12"); err == nil {
		t.Fatal("reenrolled host accepted stale exclusion")
	}
}
func TestHostCandidateBoundsPreserveIndividualAddress(t *testing.T) {
	got, err := hostCandidates([]net.Addr{interfaceAddr("100.64.1.2/24")})
	if err != nil || len(got) != 1 || got[0].String() != "100.64.1.2" {
		t.Fatal(got, err)
	}
	tooMany := make([]net.Addr, 257)
	if _, err := hostCandidates(tooMany); err == nil {
		t.Fatal("unbounded interfaces")
	}
	ips := []net.Addr{}
	for i := 1; i <= 17; i++ {
		ips = append(ips, interfaceAddr(net.IPv4(100, 64, 1, byte(i)).String()))
	}
	if _, err := hostCandidates(ips); err == nil {
		t.Fatal("unbounded lookups")
	}
}

type concurrentHostClient struct {
	base    *fakeIdentity
	mu      sync.Mutex
	calls   int
	entered chan struct{}
	release chan struct{}
}

func (f *concurrentHostClient) Status(ctx context.Context) (*ipnstate.Status, error) {
	return f.base.Status(ctx)
}
func (f *concurrentHostClient) WhoIs(ctx context.Context, addr string) (*apitype.WhoIsResponse, error) {
	if addr != "100.64.0.1" {
		return f.base.WhoIs(ctx, addr)
	}
	f.mu.Lock()
	f.calls++
	call := f.calls
	f.mu.Unlock()
	r := hostRecord("host", "100.64.0.1")
	if call == 2 {
		close(f.entered)
		select {
		case <-f.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if call == 3 {
		r.Node.Expired = true
	}
	return r, nil
}
func TestConcurrentStaleHostProofCannotRestoreAuthority(t *testing.T) {
	a, base, _ := authFixture()
	f := &concurrentHostClient{base: base, entered: make(chan struct{}), release: make(chan struct{})}
	a.client = f
	old, err := a.verify(context.Background(), "100.64.0.2:12")
	if err != nil {
		t.Fatal(err)
	}
	pending := make(chan error, 1)
	go func() { _, e := a.verify(context.Background(), "100.64.0.2:12"); pending <- e }()
	<-f.entered
	if _, err := a.verify(context.Background(), "100.64.0.2:12"); err == nil {
		t.Fatal("observed expired host accepted")
	}
	close(f.release)
	if err := <-pending; err == nil {
		t.Fatal("stale host result resurrected authority")
	}
	fresh, err := a.verify(context.Background(), "100.64.0.2:12")
	if err != nil || fresh.Generation == old.Generation {
		t.Fatal("old generation restored", err)
	}
}

func TestPrivateIdentityDiagnosticOnlyPublicMetadataNoAuthority(t *testing.T) {
	a, f, _ := authFixture()
	f.status.Self.TailscaleIPs = []netip.Addr{netip.MustParseAddr("100.64.0.3")}
	w := httptest.NewRecorder()
	a.checkHandler().ServeHTTP(w, httptest.NewRequest("GET", "/identity", nil))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || len(got) != 4 {
		t.Fatal(got, err)
	}
	for _, key := range []string{"hostNodeID", "brokerNodeID", "tailnetID", "brokerIPs"} {
		if got[key] == nil {
			t.Fatal(key)
		}
	}
	if string(got["hostNodeID"]) != `"host"` || string(got["brokerNodeID"]) != `"broker"` {
		t.Fatal(got)
	}
	// Diagnostic never records a remote authorized peer or issues browser authority.
	if len(a.authorized) != 0 {
		t.Fatal("diagnostic granted peer authority")
	}
	for _, r := range []*http.Request{
		httptest.NewRequest("POST", "/identity", nil),
		httptest.NewRequest("GET", "/identity", strings.NewReader("unexpected")),
	} {
		out := httptest.NewRecorder()
		a.checkHandler().ServeHTTP(out, r)
		if out.Code != 404 {
			t.Fatal("diagnostic accepted mutation/body")
		}
	}
}
func TestPrivateIdentityDiagnosticFailsClosedOnHostLossAndTimeout(t *testing.T) {
	a, base, _ := authFixture()
	base.status.Self.TailscaleIPs = []netip.Addr{netip.MustParseAddr("100.64.0.3")}
	f := &hostIdentityClient{base: base, records: map[string]*apitype.WhoIsResponse{"100.64.0.1": hostRecord("host", "100.64.0.1")}}
	a.client = f
	old, err := a.verify(context.Background(), "100.64.0.2:12")
	if err != nil {
		t.Fatal(err)
	}
	f.records["100.64.0.1"].Node.StableID = "replacement-host"
	out := httptest.NewRecorder()
	a.checkHandler().ServeHTTP(out, httptest.NewRequest("GET", "/identity", nil))
	if out.Code != 503 {
		t.Fatal("wrong host diagnostic accepted")
	}
	f.records["100.64.0.1"] = hostRecord("host", "100.64.0.1")
	fresh, err := a.verify(context.Background(), "100.64.0.2:12")
	if err != nil || fresh.Generation == old.Generation {
		t.Fatal("lost host proof resurrected")
	}
	f.wait = true
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	out = httptest.NewRecorder()
	a.checkHandler().ServeHTTP(out, httptest.NewRequest("GET", "/identity", nil).WithContext(ctx))
	if out.Code != 503 {
		t.Fatal("diagnostic timeout accepted")
	}
}
