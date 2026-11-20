// relay.go — the Chat relay: localhostServer as a client of a
// Remote Server.
//
// Each browser session gets its own relay connection. The browser
// drives it with JSON-RPC methods (relay.connect / relay.disconnect
// / relay.send / relay.status); messages arriving from the Remote
// Server are pushed to the browser as JSON-RPC notifications
// (relay.message, relay.status). The Remote Server protocol is
// newline-delimited JSON over TCP:
//
//	{"type":"hello","from":"localhostServer"}
//	{"type":"msg","from":"chat","text":"hi"}        browser -> remote
//	{"type":"msg","from":"remote","text":"hello"}   remote -> browser
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"time"
)

// remoteMessage is one NDJSON frame on the Remote Server protocol.
type remoteMessage struct {
	Type string `json:"type"` // "hello" | "msg"
	From string `json:"from,omitempty"`
	Text string `json:"text,omitempty"`
}

// relayClient owns one TCP connection to a Remote Server.
// The zero value is ready to use; Connect starts a read loop that
// forwards incoming messages to notify.
type relayClient struct {
	mu     sync.Mutex
	conn   net.Conn
	remote string // address actually dialed (after DNS), host:port
	notify func(method string, params any)
}

func (rc *relayClient) connected() bool {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.conn != nil
}

// connect dials host:port (host may be a domain — the dialer
// resolves it) and starts forwarding remote messages to notify.
func (rc *relayClient) connect(host string, port int) (string, error) {
	rc.mu.Lock()
	if rc.conn != nil {
		rc.mu.Unlock()
		return "", &RPCError{Code: -32000, Message: "already connected — disconnect first"}
	}
	rc.mu.Unlock()

	addr := net.JoinHostPort(host, fmt.Sprint(port))
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return "", &RPCError{Code: -32000, Message: "connect failed: " + err.Error()}
	}

	rc.mu.Lock()
	rc.conn = conn
	rc.remote = conn.RemoteAddr().String()
	remote := rc.remote
	rc.mu.Unlock()

	hello, _ := json.Marshal(remoteMessage{Type: "hello", From: "localhostServer"})
	if _, err := conn.Write(append(hello, '\n')); err != nil {
		rc.disconnect()
		return "", &RPCError{Code: -32000, Message: "hello failed: " + err.Error()}
	}
	go rc.readLoop(conn)
	return remote, nil
}

func (rc *relayClient) readLoop(conn net.Conn) {
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		var msg remoteMessage
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue // skip malformed frames
		}
		if msg.Type == "msg" && rc.notify != nil {
			rc.notify("relay.message", map[string]any{
				"from": msg.From, "text": msg.Text,
			})
		}
	}
	// Remote went away (or we disconnected): clear state and tell
	// the browser, unless this read loop is stale (a newer
	// connection already replaced it).
	rc.mu.Lock()
	current := rc.conn == conn
	if current {
		rc.conn = nil
		rc.remote = ""
	}
	rc.mu.Unlock()
	if current && rc.notify != nil {
		rc.notify("relay.status", map[string]any{"state": "disconnected"})
	}
}

func (rc *relayClient) send(text string) error {
	rc.mu.Lock()
	conn := rc.conn
	rc.mu.Unlock()
	if conn == nil {
		return &RPCError{Code: -32000, Message: "not connected"}
	}
	frame, _ := json.Marshal(remoteMessage{Type: "msg", From: "chat", Text: text})
	if _, err := conn.Write(append(frame, '\n')); err != nil {
		return &RPCError{Code: -32000, Message: "send failed: " + err.Error()}
	}
	return nil
}

func (rc *relayClient) disconnect() {
	rc.mu.Lock()
	conn := rc.conn
	rc.conn = nil
	rc.remote = ""
	rc.mu.Unlock()
	if conn != nil {
		conn.Close() // readLoop observes the close and notifies
	}
}

func (rc *relayClient) status() (state, remote string) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if rc.conn == nil {
		return "disconnected", ""
	}
	return "connected", rc.remote
}

// --- RPC surface ----------------------------------------------------------

type relayConnectParams struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

type relaySendParams struct {
	Text string `json:"text"`
}

// buildSessionDispatcher returns the Dispatcher for one browser
// session: the shared echo/ping methods plus the relay methods
// bound to that session's relay connection (Strategy + closure).
func buildSessionDispatcher(sess *session) *Dispatcher {
	d := buildDispatcher()
	relay := sess.relay

	d.Register("relay.connect", func(params json.RawMessage) (json.RawMessage, error) {
		var p relayConnectParams
		if err := json.Unmarshal(params, &p); err != nil || p.Host == "" {
			return nil, &RPCError{Code: InvalidParams, Message: "params must be {host, port}"}
		}
		if p.Port == 0 {
			p.Port = 9000
		}
		remote, err := relay.connect(p.Host, p.Port)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"remote": remote})
	})

	d.Register("relay.disconnect", func(params json.RawMessage) (json.RawMessage, error) {
		relay.disconnect()
		return json.RawMessage(`"ok"`), nil
	})

	d.Register("relay.send", func(params json.RawMessage) (json.RawMessage, error) {
		var p relaySendParams
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &RPCError{Code: InvalidParams, Message: "params must be {text}"}
		}
		if err := relay.send(p.Text); err != nil {
			return nil, err
		}
		return json.RawMessage(`"ok"`), nil
	})

	d.Register("relay.status", func(params json.RawMessage) (json.RawMessage, error) {
		state, remote := relay.status()
		return json.Marshal(map[string]any{"state": state, "remote": remote})
	})

	return d
}
