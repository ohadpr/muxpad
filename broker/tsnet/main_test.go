package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDNSValidation(t *testing.T) {
	for _, name := range []string{"muxpad-secure.example.ts.net", "muxpad-secure-1.example.ts.net"} {
		if !validDNS(name) {
			t.Fatal(name)
		}
	}
	for _, name := range []string{"localhost", "evil.ts.net.attacker.test", "test.ts.net", "a..ts.net", "a/example.ts.net", "a.Example.ts.net", "-a.example.ts.net"} {
		if validDNS(name) {
			t.Fatal(name)
		}
	}
}
func TestFixedUnixProxy(t *testing.T) {
	dir, err := os.MkdirTemp("/private/tmp", "mux-ts-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "broker.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	seen := make(chan *http.Request, 1)
	backend := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { seen <- r; _, _ = io.WriteString(w, "broker") })}
	go backend.Serve(ln)
	defer backend.Close()
	proxy := proxyHandler("https://secure.example.ts.net", socket)
	r := httptest.NewRequest("GET", "/human/session", nil)
	r.Host = "secure.example.ts.net"
	r.Header.Set("Cookie", "human-secret")
	r.Header.Set("Origin", "https://secure.example.ts.net")
	r.Header.Set("X-Forwarded-Host", "attacker")
	w := httptest.NewRecorder()
	proxy.ServeHTTP(w, r)
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "broker" {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	actual := <-seen
	if actual.Host != "secure.example.ts.net" || actual.Header.Get("Cookie") != "human-secret" || actual.Header.Get("Origin") != "https://secure.example.ts.net" || actual.Header.Get("X-Forwarded-Host") != "" {
		t.Fatal("wrong upstream or lost authentication headers")
	}
	bad := httptest.NewRequest("GET", "/", nil)
	bad.Host = "attacker.example.ts.net"
	out := httptest.NewRecorder()
	proxy.ServeHTTP(out, bad)
	if out.Code != 421 {
		t.Fatal(out.Code)
	}
	backend.Close()
	out = httptest.NewRecorder()
	proxy.ServeHTTP(out, r)
	if out.Code != 502 {
		t.Fatal("missing socket must fail closed", out.Code)
	}
}
func TestOriginWriteReplacesSymlinkWithoutFollowing(t *testing.T) {
	dir, pathErr := filepath.EvalSymlinks(t.TempDir())
	if pathErr != nil {
		t.Fatal(pathErr)
	}
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := privateDirectory(dir); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "unrelated")
	os.WriteFile(target, []byte("untouched"), 0600)
	path := filepath.Join(dir, "origin")
	os.Symlink(target, path)
	if err := writeOrigin(path, "https://secure.example.ts.net"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(target)
	if string(b) != "untouched" {
		t.Fatal("followed symlink")
	}
	b, _ = os.ReadFile(path)
	if string(b) != "https://secure.example.ts.net" {
		t.Fatal(string(b))
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0600 {
		t.Fatal(st.Mode())
	}
	os.Chmod(dir, 0755)
	if privateDirectory(dir) == nil {
		t.Fatal("accepted public state directory")
	}
}

func TestIdentityDirectoryRejectsACLBeforeEnrollment(t *testing.T) {
	dir, pathErr := filepath.EvalSymlinks(t.TempDir())
	if pathErr != nil {
		t.Fatal(pathErr)
	}
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	user := os.Getenv("USER")
	if user == "" {
		t.Skip("no OS username for ACL fixture")
	}
	rule := "user:" + user + ":allow:read,search"
	if out, err := exec.Command("/bin/chmod", "+a", rule, dir).CombinedOutput(); err != nil {
		t.Fatalf("ACL fixture: %v %s", err, out)
	}
	defer exec.Command("/bin/chmod", "-N", dir).Run()
	if err := privateDirectory(dir); err == nil || !strings.Contains(err.Error(), "ACL") {
		t.Fatalf("did not reject ACL: %v", err)
	}
}
