package mail_test

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/mail"
)

// A relay that accepts the connection, greets, and then never speaks again.
//
// This is the failure these tests exist for, and it is the ordinary one: a
// mail host reached across a censored network does not usually refuse the
// connection, it goes quiet partway through. `net/smtp.SendMail`, which this
// package used to call, has no deadline anywhere — not on the dial and not on
// the connection afterwards — and consults no context, so a relay behaving
// like this held the goroutine serving the login request for the life of the
// process.
func silentRelay(t *testing.T) string {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = conn.Write([]byte("220 silent ESMTP\r\n"))
				// And nothing more, until the test is over.
				select {}
			}()
		}
	}()
	return listener.Addr().String()
}

func TestSendGivesUpOnASilentRelay(t *testing.T) {
	host, port, err := net.SplitHostPort(silentRelay(t))
	if err != nil {
		t.Fatal(err)
	}
	sender := mail.NewSMTP(mail.SMTPConfig{Host: host, Port: port, From: "a@b.co"})

	done := make(chan error, 1)
	go func() { done <- sender.Send(context.Background(), mail.Message{To: "c@d.co", Text: "hi"}) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected a failure from a relay that never answers")
		}
	case <-time.After(60 * time.Second):
		t.Fatal("still waiting after a minute: the send is unbounded again")
	}
}

// The caller's deadline is the caller's deadline. It was ignored entirely
// before, because SendMail takes no context and this package passed it none.
func TestSendHonoursTheCallersDeadline(t *testing.T) {
	host, port, err := net.SplitHostPort(silentRelay(t))
	if err != nil {
		t.Fatal(err)
	}
	sender := mail.NewSMTP(mail.SMTPConfig{Host: host, Port: port, From: "a@b.co"})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	start := time.Now()
	if err := sender.Send(ctx, mail.Message{To: "c@d.co", Text: "hi"}); err == nil {
		t.Fatal("expected a failure")
	}
	// Generously above the deadline and far below the send's own budget, so
	// this asserts the context was honoured rather than that a timer is exact.
	if elapsed := time.Since(start); elapsed > 15*time.Second {
		t.Fatalf("ignored the caller's 2s deadline: took %s", elapsed)
	}
}
