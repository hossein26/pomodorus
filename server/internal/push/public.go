package push

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"syscall"
)

// Where this server may open a connection when it delivers a bell.
//
// The endpoint on a subscription is a URL the *client* handed over. A browser
// fills it in with whatever its push service minted, and every real one is on
// the public internet — but nothing about the request proves that, and the
// server is the one that dials it. Left unchecked, "tell my devices" is a way
// to make this process open connections to things only it can reach: the
// database on the compose network, an admin port on the host, a cloud
// provider's metadata service on 169.254.169.254.
//
// The check is at the moment the socket is opened rather than when the
// subscription was stored, which is what makes it complete. A name checked at
// subscribe time and resolved again at send time is two different answers, and
// the gap between them is DNS rebinding — the endpoint resolves publicly while
// it is being vetted and to a private address twenty-five minutes later, when
// it is actually dialled. There is no gap here: this runs with the address the
// connection is about to use.

// ErrNotPublic is a dial refused because of where it was going. It is a send
// failure like any other — the bell is missed and the subscription is left
// alone — and it is a sentinel so that a test can say which failure it was.
var ErrNotPublic = errors.New("push: the endpoint does not resolve to a public address")

// The ranges netip has no predicate for, and which no push service is on.
var reserved = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),      // "this network"
	netip.MustParsePrefix("100.64.0.0/10"),  // carrier-grade NAT
	netip.MustParsePrefix("192.0.0.0/24"),   // IETF protocol assignments
	netip.MustParsePrefix("198.18.0.0/15"),  // benchmarking
	netip.MustParsePrefix("2001:db8::/32"),  // documentation
	netip.MustParsePrefix("64:ff9b:1::/48"), // local-use NAT64
	netip.MustParsePrefix("100::/64"),       // discard-only
}

// refuseNonPublic is the dialer's Control hook: it runs after the name has been
// resolved and before the connection is made, and returning an error is what
// stops the connection happening at all.
func refuseNonPublic(network, address string, _ syscall.RawConn) error {
	switch network {
	case "tcp", "tcp4", "tcp6":
	default:
		// A push service is HTTP over TCP. Anything else is not one.
		return fmt.Errorf("%w: %s is not tcp", ErrNotPublic, network)
	}

	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("%w: cannot read an address out of %q", ErrNotPublic, address)
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		// Control is handed a resolved address, so this is unreachable — and
		// if it somehow were not, an address this cannot read is one it cannot
		// vouch for.
		return fmt.Errorf("%w: %q is not an address", ErrNotPublic, host)
	}
	if !IsPublic(addr) {
		return fmt.Errorf("%w: %s", ErrNotPublic, addr)
	}
	return nil
}

// IsPublic reports whether an address is one out on the internet, as opposed to
// one that means something only from inside this network or this machine.
//
// Exported because the subscribe handler uses it too. That check is not this
// one and does not replace it: it refuses an endpoint written as a private IP
// literal outright, so a client gets a 400 instead of a subscription that
// silently never delivers. Everything reached through a name is this function's
// job, at dial time.
func IsPublic(addr netip.Addr) bool {
	// An IPv4 address wearing an IPv6 mapping is still that IPv4 address, and
	// ::ffff:127.0.0.1 must not read as a global unicast v6 address.
	addr = addr.Unmap()

	switch {
	case !addr.IsValid():
		return false
	case addr.IsLoopback(), addr.IsUnspecified():
		return false
	case addr.IsPrivate():
		// RFC 1918 for v4, and RFC 4193 unique-local for v6.
		return false
	case addr.IsLinkLocalUnicast(), addr.IsLinkLocalMulticast():
		// 169.254.0.0/16 and fe80::/10 — the cloud metadata services live here.
		return false
	case addr.IsMulticast(), addr.IsInterfaceLocalMulticast():
		return false
	}
	for _, prefix := range reserved {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}
