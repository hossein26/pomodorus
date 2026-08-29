// Package mail sends the one kind of message this app sends: a login code.
//
// Locally that goes to Mailpit over the same SMTP client that runs in
// production, rather than through a development-only branch — so what is
// exercised in a test is the code path that ships. The in-memory
// implementation exists for the API tests, where reading the code out of a
// slice is what makes the whole login flow legible in one function.
package mail

import (
	"context"
	"crypto/tls"
	"fmt"
	"mime"
	"net"
	netmail "net/mail"
	"net/smtp"
	"strings"
	"sync"
	"time"
)

type Message struct {
	To      string
	Subject string
	Text    string
}

type Mailer interface {
	Send(ctx context.Context, msg Message) error
}

// SMTPConfig is what a provider gives you. Username and password are empty
// against Mailpit, which accepts unauthenticated mail.
type SMTPConfig struct {
	Host     string
	Port     string
	Username string
	Password string
	From     string
}

func NewSMTP(cfg SMTPConfig) *SMTP { return &SMTP{cfg: cfg} }

type SMTP struct{ cfg SMTPConfig }

// sendTimeout is the whole budget for handing one message to the relay.
//
// It exists because `smtp.SendMail` has no timeout of any kind: it dials with
// no deadline and never sets one on the connection afterwards. A relay that
// accepts the TCP connection and then stops answering — which is the ordinary
// failure of a mail host reached across a censored network, rather than an
// exotic one — holds the goroutine that is serving the login request forever.
// Nothing upstream can free it: the handler's context is not something
// SendMail consults, so the caller's deadline is not the caller's deadline.
//
// Generous, because a slow relay is still a working relay and a login code is
// worth waiting for; finite, because the alternative is not waiting longer, it
// is waiting for the rest of the process's life.
const sendTimeout = 30 * time.Second

func (s *SMTP) Send(ctx context.Context, msg Message) error {
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()

	if err := s.send(ctx, msg); err != nil {
		return fmt.Errorf("send to %s: %w", msg.To, err)
	}
	return nil
}

// send is net/smtp's own SendMail with the two deadlines it does not have, and
// otherwise the same conversation in the same order.
//
// STARTTLS rather than implicit TLS is deliberate and is a fact about the
// port: the relay is reached on 587, which is plain until it is upgraded. See
// docs/deploy-liara.md — pointing this at 465 hangs, which is exactly the
// failure the deadlines below now bound rather than the one they prevent.
func (s *SMTP) send(ctx context.Context, msg Message) error {
	addr := net.JoinHostPort(s.cfg.Host, s.cfg.Port)

	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("dial %s: %w", addr, err)
	}
	defer conn.Close()

	// The deadline covers every read and write for the rest of the exchange,
	// which is the half SendMail leaves open: a dial timeout alone still lets
	// a host that answers the connection and then says nothing hold this
	// goroutine indefinitely.
	if deadline, ok := ctx.Deadline(); ok {
		if err := conn.SetDeadline(deadline); err != nil {
			return fmt.Errorf("set deadline: %w", err)
		}
	}

	client, err := smtp.NewClient(conn, s.cfg.Host)
	if err != nil {
		return fmt.Errorf("greet: %w", err)
	}
	defer client.Close()

	if ok, _ := client.Extension("STARTTLS"); ok {
		if err := client.StartTLS(&tls.Config{ServerName: s.cfg.Host}); err != nil {
			return fmt.Errorf("starttls: %w", err)
		}
	}

	// nil auth rather than an empty PlainAuth: net/smtp refuses to send
	// credentials over an unencrypted connection, which is exactly the local
	// case, and an empty username is not a credential worth sending anyway.
	if s.cfg.Username != "" {
		auth := smtp.PlainAuth("", s.cfg.Username, s.cfg.Password, s.cfg.Host)
		if ok, _ := client.Extension("AUTH"); ok {
			if err := client.Auth(auth); err != nil {
				return fmt.Errorf("auth: %w", err)
			}
		}
	}

	if err := client.Mail(envelopeAddress(s.cfg.From)); err != nil {
		return fmt.Errorf("mail from: %w", err)
	}
	if err := client.Rcpt(msg.To); err != nil {
		return fmt.Errorf("rcpt to: %w", err)
	}
	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("data: %w", err)
	}
	if _, err := w.Write(s.compose(msg)); err != nil {
		return fmt.Errorf("write body: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("close body: %w", err)
	}
	return client.Quit()
}

// envelopeAddress strips the display name. SMTP's MAIL FROM takes a bare
// address and refuses «Pomodorus <no-reply@…>» outright; the display name
// belongs in the From header, which is a different thing entirely.
func envelopeAddress(from string) string {
	if parsed, err := netmail.ParseAddress(from); err == nil {
		return parsed.Address
	}
	return from
}

func (s *SMTP) compose(msg Message) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", s.cfg.From)
	fmt.Fprintf(&b, "To: %s\r\n", msg.To)
	// RFC 2047, because the subject is Persian and a raw UTF-8 header is not
	// something every mail server will carry intact. Encode leaves plain
	// ASCII alone, so this costs nothing when there is nothing to encode.
	fmt.Fprintf(&b, "Subject: %s\r\n", mime.QEncoding.Encode("utf-8", msg.Subject))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	b.WriteString("\r\n")
	b.WriteString(msg.Text)
	return []byte(b.String())
}

// Memory keeps every message it is given, so a test can read the code the
// user would have read.
type Memory struct {
	mu   sync.Mutex
	sent []Message
}

func NewMemory() *Memory { return &Memory{} }

func (m *Memory) Send(_ context.Context, msg Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, msg)
	return nil
}

// Sent returns every message so far, oldest first.
func (m *Memory) Sent() []Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Message{}, m.sent...)
}

// Last returns the most recent message, and whether there was one.
func (m *Memory) Last() (Message, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sent) == 0 {
		return Message{}, false
	}
	return m.sent[len(m.sent)-1], true
}
