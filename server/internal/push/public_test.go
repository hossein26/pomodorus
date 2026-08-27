package push

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestIsPublic(t *testing.T) {
	tests := []struct {
		addr string
		want bool
		why  string
	}{
		{"93.184.216.34", true, "an ordinary address out on the internet"},
		{"2606:2800:220:1:248:1893:25c8:1946", true, "the same, over v6"},

		{"127.0.0.1", false, "loopback"},
		{"::1", false, "loopback, v6"},
		{"10.0.0.5", false, "RFC 1918"},
		{"172.16.0.1", false, "RFC 1918"},
		{"192.168.1.1", false, "RFC 1918"},
		{"fd00::1", false, "unique-local v6"},
		{"169.254.169.254", false, "the cloud metadata service"},
		{"fe80::1", false, "link-local v6"},
		{"0.0.0.0", false, "unspecified"},
		{"::", false, "unspecified, v6"},
		{"224.0.0.1", false, "multicast"},
		{"100.64.0.1", false, "carrier-grade NAT, which is where a container network often is"},
		{"192.0.0.1", false, "IETF protocol assignments"},
		{"198.18.0.1", false, "benchmarking"},

		// The one that a naive check gets wrong: an IPv4 loopback address
		// wearing a v6 mapping is still loopback, but it answers yes to every
		// question about global v6 unicast unless it is unmapped first.
		{"::ffff:127.0.0.1", false, "loopback wearing a v6 mapping"},
		{"::ffff:10.0.0.5", false, "RFC 1918 wearing a v6 mapping"},
	}

	for _, tc := range tests {
		t.Run(tc.addr, func(t *testing.T) {
			addr, err := netip.ParseAddr(tc.addr)
			if err != nil {
				t.Fatalf("the test's own address does not parse: %v", err)
			}
			if got := IsPublic(addr); got != tc.want {
				t.Errorf("IsPublic(%s) = %v, want %v — %s", tc.addr, got, tc.want, tc.why)
			}
		})
	}
}

// The check that matters, made against a server that really exists: an
// endpoint pointing back inside this machine is refused at the socket rather
// than at the URL, so a name that resolves to loopback is refused too.
func TestTheSenderWillNotDialSomethingOnThisMachine(t *testing.T) {
	reached := false
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusCreated)
	}))
	defer local.Close()

	// The transport under test, driven directly. Going through Send would mean
	// asserting on this while also encrypting a payload against a keypair, and
	// what is in question is only where the connection is allowed to go.
	client := &http.Client{Transport: publicOnlyTransport()}

	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, local.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Do(req)
	if err == nil {
		t.Fatal("the dial succeeded: a subscription can reach a service on this host")
	}
	if !errors.Is(err, ErrNotPublic) {
		t.Errorf("refused for the wrong reason: %v", err)
	}
	if reached {
		t.Error("the request arrived, so it was refused after the connection rather than before it")
	}
}

// localhost is the naive case, and it is worth its own test because the check
// is on the resolved address rather than on the string: nothing here matches
// on the word.
func TestTheSenderWillNotDialAHostnameThatResolvesInwards(t *testing.T) {
	client := &http.Client{Transport: publicOnlyTransport()}

	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, "https://localhost:9/", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Do(req); !errors.Is(err, ErrNotPublic) {
		t.Errorf("localhost was refused for the wrong reason: %v", err)
	}
}
