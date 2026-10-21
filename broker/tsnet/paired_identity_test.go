package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
	"testing"
	"time"
)

func pairedFixture() (*hostIdentityClient, func() ([]net.Addr, error)) {
	_, f, _ := authFixture()
	f.status.Self.TailscaleIPs = []netip.Addr{netip.MustParseAddr("100.64.0.3")}
	r := hostRecord("host", "100.64.0.1")
	r.Node.MachineAuthorized = true
	c := &hostIdentityClient{base: f, records: map[string]*apitype.WhoIsResponse{"100.64.0.1": r}}
	return c, func() ([]net.Addr, error) { return []net.Addr{interfaceAddr("100.64.0.1/32")}, nil }
}
func TestPairedDiscoveryNoPolicy(t *testing.T) {
	c, ips := pairedFixture()
	out, e := discoverPairedIdentity(context.Background(), c, ips)
	if e != nil || out.HostNodeID != "host" || out.BrokerNodeID != "broker" || out.TailnetID != "tailnet1" {
		t.Fatalf("%+v %v", out, e)
	}
}
func TestPairedDiscoveryRefuses(t *testing.T) {
	for _, kind := range []string{"tagged", "shared", "expired", "self", "wrongowner", "indirect", "missinginterfaces", "missingtailnet", "missingIPs", "unknownIP", "timeout"} {
		t.Run(kind, func(t *testing.T) {
			c, ips := pairedFixture()
			n := c.records["100.64.0.1"].Node
			switch kind {
			case "tagged":
				n.Tags = []string{"tag:host"}
			case "shared":
				n.Sharer = 43
			case "expired":
				n.Expired = true
			case "self":
				n.StableID = "broker"
			case "wrongowner":
				n.User = 43
			case "indirect":
				n.Addresses = []netip.Prefix{netip.MustParsePrefix("100.64.0.0/24")}
			case "missinginterfaces":
				ips = func() ([]net.Addr, error) { return nil, nil }
			case "missingtailnet":
				c.base.status.CurrentTailnet = nil
			case "missingIPs":
				c.base.status.Self.TailscaleIPs = nil
			case "unknownIP":
				ips = func() ([]net.Addr, error) { return []net.Addr{interfaceAddr("100.64.0.99/32")}, nil }
			case "timeout":
				c.wait = true
			}
			ctx, cancel := context.WithCancel(context.Background())
			if kind == "timeout" {
				cancel()
			}
			defer cancel()
			if out, e := discoverPairedIdentity(ctx, c, ips); e == nil || out != nil {
				t.Fatalf("accepted %+v", out)
			}
		})
	}
}
func TestPairedDiagnosticStrictAndPublicOnly(t *testing.T) {
	c, ips := pairedFixture()
	h := pairedIdentityHandler(c, ips)
	for _, path := range []string{"/identity?x=1", "/identity?", "/check", "/human/session"} {
		r := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 404 {
			t.Fatal(path, w.Code)
		}
	}
	for _, method := range []string{"POST", "HEAD"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, "/identity", nil))
		if w.Code != 404 {
			t.Fatal(method)
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/identity", strings.NewReader("x")))
	if w.Code != 404 {
		t.Fatal("body")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/identity", nil))
	var got map[string]any
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &got) != nil || len(got) != 4 || w.Header().Get("X-Muxpad-Diagnostic-Version") != pairedIdentityVersion {
		t.Fatal(w.Code, w.Body.String())
	}
}

type pairedBlockedClient struct {
	identityClient
	entered chan struct{}
}

func (c *pairedBlockedClient) WhoIs(ctx context.Context, addr string) (*apitype.WhoIsResponse, error) {
	c.entered <- struct{}{}
	<-ctx.Done()
	return nil, ctx.Err()
}
func TestPairedDiagnosticCapacityAndCancellation(t *testing.T) {
	base, ips := pairedFixture()
	c := &pairedBlockedClient{identityClient: base, entered: make(chan struct{}, 16)}
	h := pairedIdentityHandler(c, ips)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan int, 16)
	for i := 0; i < 16; i++ {
		go func() {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "/identity", nil).WithContext(ctx))
			done <- w.Code
		}()
	}
	for i := 0; i < 16; i++ {
		select {
		case <-c.entered:
		case <-time.After(time.Second):
			t.Fatal("not admitted")
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/identity", nil))
	if w.Code != 503 {
		t.Fatal("overflow", w.Code)
	}
	if !strings.Contains(w.Body.String(), "DIAG_BUSY") {
		t.Fatal("missing busy code", w.Body.String())
	}
	cancel()
	for i := 0; i < 16; i++ {
		select {
		case code := <-done:
			if code != 503 {
				t.Fatal(code)
			}
		case <-time.After(time.Second):
			t.Fatal("cancel not propagated")
		}
	}
}

func TestPairedDiagnosticBindFailureIsOptional(t *testing.T) {
	c, ips := pairedFixture()
	reported := false
	srv := startPairedDiagnostic(c, ips, func() (net.Listener, error) { return nil, errors.New("occupied") }, func() { reported = true })
	if srv != nil || !reported {
		t.Fatal("failed bind not disabled/reported")
	}
	// Failure did not change client/status or require a member policy.
	if out, e := discoverPairedIdentity(context.Background(), c, ips); e != nil || out.HostNodeID != "host" {
		t.Fatal(out, e)
	}
}
func TestPairedDiagnosticSocketProtection(t *testing.T) {
	parent, e := filepath.EvalSymlinks(os.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	dir, e := os.MkdirTemp(parent, "pd-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "d.sock")
	ln, e := pairedIdentityListener(path)
	if e != nil {
		t.Fatal(e)
	}
	if other, e := pairedIdentityListener(path); e == nil {
		other.Close()
		t.Fatal("replaced live socket")
	}
	ln.Close()
	target := filepath.Join(dir, "target")
	os.WriteFile(target, []byte("keep"), 0600)
	os.Symlink(target, path)
	if other, e := pairedIdentityListener(path); e == nil {
		other.Close()
		t.Fatal("followed symlink")
	}
	os.Remove(path)
	os.WriteFile(path, []byte("keep"), 0600)
	if other, e := pairedIdentityListener(path); e == nil {
		other.Close()
		t.Fatal("removed regular file")
	}
}

type pairedChangingClient struct {
	identityClient
	calls int
	kind  string
}

func (c *pairedChangingClient) Status(ctx context.Context) (*ipnstate.Status, error) {
	s, e := c.identityClient.Status(ctx)
	if e != nil {
		return nil, e
	}
	c.calls++
	copyStatus := *s
	self := *s.Self
	team := *s.CurrentTailnet
	copyStatus.Self = &self
	copyStatus.CurrentTailnet = &team
	if c.calls > 1 {
		switch c.kind {
		case "self":
			self.ID = "different"
		case "tailnet":
			team.StableID = "different"
		case "IPs":
			self.TailscaleIPs = []netip.Addr{netip.MustParseAddr("100.64.0.4")}
		}
	}
	return &copyStatus, nil
}
func TestPairedDiscoveryContextChangeNoPartialOutput(t *testing.T) {
	for _, kind := range []string{"self", "tailnet", "IPs"} {
		t.Run(kind, func(t *testing.T) {
			base, ips := pairedFixture()
			c := &pairedChangingClient{identityClient: base, kind: kind}
			if out, e := discoverPairedIdentity(context.Background(), c, ips); e == nil || out != nil {
				t.Fatal("context change accepted", out, e)
			}
		})
	}
}

func TestPairedDiagnosticConstantStageCodesNoValues(t *testing.T) {
	cases := []struct{ name, code string }{
		{"status", "DIAG_OWN_STATUS_LOOKUP"}, {"missingtailnet", "DIAG_TAILNET_ID_MISSING"}, {"missingIPs", "DIAG_BROKER_IPS_MISSING"}, {"badIP", "DIAG_BROKER_IP_INVALID"},
		{"interfaceerror", "DIAG_KERNEL_INTERFACES"}, {"missinginterfaces", "DIAG_HOST_CANDIDATES"}, {"cancelled", "DIAG_CANCELLED"}, {"lookup", "DIAG_HOST_LOOKUP"},
		{"hostid", "DIAG_HOST_ID"}, {"self", "DIAG_HOST_IS_SELF"}, {"owner", "DIAG_HOST_OWNER"}, {"shared", "DIAG_HOST_SHARED"}, {"tagged", "DIAG_HOST_TAGGED"}, {"jailed", "DIAG_HOST_JAILED"}, {"expired", "DIAG_HOST_EXPIRED"}, {"unsigned", "DIAG_HOST_UNSIGNED"}, {"wireguard", "DIAG_HOST_WIREGUARD"}, {"indirect", "DIAG_HOST_NOT_DIRECT"}, {"conflict", "DIAG_HOST_CONFLICT"}, {"final", "DIAG_FINAL_CONTEXT"}, {"changedIPs", "DIAG_BROKER_IP_CHANGED"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, ips := pairedFixture()
			var client identityClient = c
			n := c.records["100.64.0.1"].Node
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch tc.name {
			case "status":
				c.base.statusErr = errors.New("SECRET /private/path")
			case "missingtailnet":
				c.base.status.CurrentTailnet = nil
			case "missingIPs":
				c.base.status.Self.TailscaleIPs = nil
			case "badIP":
				c.base.status.Self.TailscaleIPs = []netip.Addr{netip.MustParseAddr("192.168.1.1")}
			case "interfaceerror":
				ips = func() ([]net.Addr, error) { return nil, errors.New("SECRET /private/path") }
			case "missinginterfaces":
				ips = func() ([]net.Addr, error) { return nil, nil }
			case "cancelled":
				cancel()
			case "lookup":
				ips = func() ([]net.Addr, error) { return []net.Addr{interfaceAddr("100.99.0.1/32")}, nil }
			case "hostid":
				n.StableID = "INVALID SECRET"
			case "self":
				n.StableID = "broker"
			case "owner":
				n.User = 43
			case "shared":
				n.Sharer = 43
			case "tagged":
				n.Tags = []string{"tag:SECRET"}
			case "jailed":
				n.IsJailed = true
			case "expired":
				n.Expired = true
			case "unsigned":
				n.UnsignedPeerAPIOnly = true
			case "wireguard":
				n.IsWireGuardOnly = true
			case "indirect":
				n.Addresses = []netip.Prefix{netip.MustParsePrefix("100.64.0.0/24")}
			case "conflict":
				r := hostRecord("otherhost", "100.64.0.2")
				r.Node.MachineAuthorized = true
				c.records["100.64.0.2"] = r
				ips = func() ([]net.Addr, error) {
					return []net.Addr{interfaceAddr("100.64.0.1/32"), interfaceAddr("100.64.0.2/32")}, nil
				}
			case "final":
				client = &pairedChangingClient{identityClient: c, kind: "self"}
			case "changedIPs":
				client = &pairedChangingClient{identityClient: c, kind: "IPs"}
			}
			w := httptest.NewRecorder()
			pairedIdentityHandler(client, ips).ServeHTTP(w, httptest.NewRequest("GET", "/identity", nil).WithContext(ctx))
			var body map[string]string
			if w.Code != 503 || json.Unmarshal(w.Body.Bytes(), &body) != nil || len(body) != 1 || body["error"] != tc.code {
				t.Fatal(w.Code, w.Body.String())
			}
			for _, value := range []string{"SECRET", "/private/", "100.64", "hostNodeID", "tailnet1"} {
				if strings.Contains(w.Body.String(), value) {
					t.Fatal("value leak", w.Body.String())
				}
			}
		})
	}
}

func TestPairedCandidateWhoIsMachineAuthorizedPresenceDoesNotGrantAuthority(t *testing.T) {
	for _, field := range []string{"", `,"MachineAuthorized":false`, `,"MachineAuthorized":true`} {
		t.Run(field, func(t *testing.T) {
			c, ips := pairedFixture()
			raw := `{"Node":{"StableID":"host","User":42,"Addresses":["100.64.0.1/32"]` + field + `},"UserProfile":{"ID":42}}`
			var who apitype.WhoIsResponse
			if e := json.Unmarshal([]byte(raw), &who); e != nil {
				t.Fatal(e)
			}
			c.records["100.64.0.1"] = &who
			out, e := discoverPairedIdentity(context.Background(), c, ips)
			if e != nil || out.HostNodeID != "host" {
				t.Fatal(out, e)
			}
			for _, kind := range []string{"expired", "shared", "tagged", "owner", "indirect"} {
				copyNode := *who.Node
				bad := who
				bad.Node = &copyNode
				switch kind {
				case "expired":
					copyNode.Expired = true
				case "shared":
					copyNode.Sharer = 43
				case "tagged":
					copyNode.Tags = []string{"tag:host"}
				case "owner":
					copyNode.User = 43
				case "indirect":
					copyNode.Addresses = []netip.Prefix{netip.MustParsePrefix("100.64.0.0/24")}
				}
				c.records["100.64.0.1"] = &bad
				if result, e := discoverPairedIdentity(context.Background(), c, ips); e == nil || result != nil {
					t.Fatal("other check weakened", kind)
				}
			}
		})
	}
}
