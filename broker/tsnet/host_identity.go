package main

import (
	"context"
	"crypto/rand"
	"errors"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"tailscale.com/ipn/ipnstate"
	"time"
)

var tailnetV4 = netip.MustParsePrefix("100.64.0.0/10")
var tailnetV6 = netip.MustParsePrefix("fd7a:115c:a1e0::/48")

// Kernel interface addresses, never mutable CLI/header claims. This is a
// consistency check, NOT proof of key possession or enrollment isolation.
func hostCandidates(addrs []net.Addr) ([]netip.Addr, error) {
	if len(addrs) > 256 {
		return nil, errors.New("too many interface addresses")
	}
	seen := map[netip.Addr]bool{}
	for _, raw := range addrs {
		if raw == nil {
			return nil, errors.New("invalid interface address")
		}
		ip, err := netip.ParseAddr(raw.String())
		if err != nil {
			p, e := netip.ParsePrefix(raw.String())
			if e != nil {
				return nil, errors.New("invalid interface address")
			}
			ip = p.Addr()
		}
		ip = ip.Unmap()
		if !tailnetV4.Contains(ip) && !tailnetV6.Contains(ip) {
			continue
		}
		if ip.Zone() != "" {
			return nil, errors.New("scoped tailnet address unsupported")
		}
		seen[ip] = true
	}
	if len(seen) == 0 || len(seen) > 16 {
		return nil, errors.New("missing or ambiguous host interfaces")
	}
	out := make([]netip.Addr, 0, len(seen))
	for ip := range seen {
		out = append(out, ip)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Compare(out[j]) < 0 })
	return out, nil
}
func (a *nodeAuthority) verifyHost(ctx context.Context, p *nodePolicy, status *ipnstate.Status, generation string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if p.BrokerNodeID != a.self || p.HostNodeID == a.self || status == nil || status.BackendState != "Running" ||
		status.Self == nil || status.Self.Expired || string(status.Self.ID) != a.self ||
		status.CurrentTailnet == nil || string(status.CurrentTailnet.StableID) != p.TailnetID {
		return errors.New("helper identity context unavailable")
	}
	enumerate := a.interfaces
	if enumerate == nil {
		enumerate = net.InterfaceAddrs
	}
	raw, err := enumerate()
	if err != nil {
		return errors.New("kernel interfaces unavailable")
	}
	ips, err := hostCandidates(raw)
	if err != nil {
		return err
	}
	owner := ""
	parts := []string{p.HostNodeID}
	for _, ip := range ips {
		if err := ctx.Err(); err != nil {
			return err
		}
		who, err := a.client.WhoIs(ctx, ip.String())
		if err != nil || who == nil || who.Node == nil || who.UserProfile == nil {
			return errors.New("host identity unavailable")
		}
		n := who.Node
		if string(n.StableID) != p.HostNodeID || n.User <= 0 || n.User != who.UserProfile.ID ||
			n.Sharer != 0 || n.IsJailed || n.Expired || n.UnsignedPeerAPIOnly || n.IsWireGuardOnly ||
			(!n.KeyExpiry.IsZero() && !n.KeyExpiry.After(time.Now())) {
			return errors.New("actual host identity does not match protected exclusion")
		}
		direct := false
		for _, prefix := range n.Addresses {
			if prefix.Addr().Unmap() == ip {
				direct = true
			}
		}
		if !direct {
			return errors.New("host address is indirect")
		}
		next := strconv.FormatInt(int64(n.User), 10)
		if owner != "" && owner != next {
			return errors.New("conflicting host owners")
		}
		owner = next
		parts = append(parts, ip.String())
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	parts = append(parts, owner)
	proof := strings.Join(parts, "|")
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.generation != generation || a.observedPolicy != p.digest || a.retired[p.digest] {
		return errors.New("host proof generation changed")
	}
	if a.hostProof != "" && a.hostProof != proof {
		a.hostProof = proof
		a.generation = rand.Text()
		return errors.New("host interface or identity changed")
	}
	a.hostProof = proof
	return nil
}

// Private metadata-only diagnostic on the existing authority socket. Never
// starts a duplicate tsnet node, reads key files, creates sessions or approves.
type publicNodeIdentity struct {
	HostNodeID   string   `json:"hostNodeID"`
	BrokerNodeID string   `json:"brokerNodeID"`
	TailnetID    string   `json:"tailnetID"`
	BrokerIPs    []string `json:"brokerIPs"`
}

func (a *nodeAuthority) publicIdentity(parent context.Context) (*publicNodeIdentity, error) {
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	p, err := a.load()
	if err != nil {
		a.identityFault()
		return nil, err
	}
	gen, err := a.policyGeneration(p.digest)
	if err != nil {
		return nil, err
	}
	status, err := a.client.Status(ctx)
	if err != nil {
		a.identityFault()
		return nil, err
	}
	if err = a.verifyHost(ctx, p, status, gen); err != nil {
		a.identityFault()
		return nil, err
	}
	ips := []string{}
	if len(status.Self.TailscaleIPs) == 0 || len(status.Self.TailscaleIPs) > 16 {
		return nil, errors.New("missing broker addresses")
	}
	for _, ip := range status.Self.TailscaleIPs {
		if !ip.IsValid() || ip.Zone() != "" || (!tailnetV4.Contains(ip.Unmap()) && !tailnetV6.Contains(ip.Unmap())) {
			return nil, errors.New("invalid broker address")
		}
		ips = append(ips, ip.Unmap().String())
	}
	current, err := a.load()
	if err != nil || current.digest != p.digest || ctx.Err() != nil {
		a.identityFault()
		return nil, errors.New("identity policy changed")
	}
	a.mu.Lock()
	valid := a.generation == gen && a.observedPolicy == p.digest && !a.retired[p.digest]
	a.mu.Unlock()
	if !valid {
		return nil, errors.New("identity generation changed")
	}
	return &publicNodeIdentity{HostNodeID: p.HostNodeID, BrokerNodeID: a.self, TailnetID: p.TailnetID, BrokerIPs: ips}, nil
}
