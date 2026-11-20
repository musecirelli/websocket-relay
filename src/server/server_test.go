package main

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// server_test.go — integration tests: the real HTTP handler over a
// real WebSocket connection, and the real GUI page over HTTP.
//
// The WebSocket test client below is hand-rolled on the standard
// library: the maintained third-party clients (coder/websocket)
// require Go 1.23+, and this module targets Go 1.20. Client frames
// must be masked (RFC 6455 §5.3); server frames are not.

func startTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(buildMux())
	t.Cleanup(srv.Close)
	return srv
}

// --- minimal stdlib WebSocket client (test-only) ---------------------------

type wsTestClient struct {
	conn net.Conn
	r    *bufio.Reader
}

func dialWS(t *testing.T, srv *httptest.Server) *wsTestClient {
	t.Helper()
	host := strings.TrimPrefix(srv.URL, "http://")
	conn, err := net.Dial("tcp", host)
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })

	keyBytes := make([]byte, 16)
	_, err = rand.Read(keyBytes)
	require.NoError(t, err)
	key := base64.StdEncoding.EncodeToString(keyBytes)

	_, err = fmt.Fprintf(conn,
		"GET / HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n",
		host, key)
	require.NoError(t, err)

	r := bufio.NewReader(conn)
	status, err := r.ReadString('\n')
	require.NoError(t, err)
	require.Contains(t, status, "101", "handshake must be accepted")
	for { // consume headers up to the blank line
		line, err := r.ReadString('\n')
		require.NoError(t, err)
		if line == "\r\n" {
			break
		}
	}
	return &wsTestClient{conn: conn, r: r}
}

func (c *wsTestClient) writeText(payload []byte) error {
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	header := []byte{0x81} // FIN + text opcode
	switch n := len(payload); {
	case n < 126:
		header = append(header, 0x80|byte(n))
	case n <= 65535:
		header = append(header, 0x80|126, byte(n>>8), byte(n))
	default:
		return fmt.Errorf("test payload too large: %d bytes", n)
	}
	header = append(header, mask[:]...)
	masked := make([]byte, len(payload))
	for i, b := range payload {
		masked[i] = b ^ mask[i%4]
	}
	if _, err := c.conn.Write(header); err != nil {
		return err
	}
	_, err := c.conn.Write(masked)
	return err
}

func (c *wsTestClient) readText() ([]byte, error) {
	for {
		var h [2]byte
		if _, err := io.ReadFull(c.r, h[:]); err != nil {
			return nil, err
		}
		opcode := h[0] & 0x0f
		length := int64(h[1] & 0x7f)
		if length == 126 {
			var ext [2]byte
			if _, err := io.ReadFull(c.r, ext[:]); err != nil {
				return nil, err
			}
			length = int64(binary.BigEndian.Uint16(ext[:]))
		} else if length == 127 {
			var ext [8]byte
			if _, err := io.ReadFull(c.r, ext[:]); err != nil {
				return nil, err
			}
			length = int64(binary.BigEndian.Uint64(ext[:]))
		}
		var mask [4]byte
		if h[1]&0x80 != 0 {
			if _, err := io.ReadFull(c.r, mask[:]); err != nil {
				return nil, err
			}
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(c.r, payload); err != nil {
			return nil, err
		}
		if h[1]&0x80 != 0 {
			for i := range payload {
				payload[i] ^= mask[i%4]
			}
		}
		switch opcode {
		case 1, 2: // text / binary
			return payload, nil
		case 8: // close
			return nil, io.EOF
		default: // ping/pong/continuation: keep reading
			continue
		}
	}
}

// --- tests -----------------------------------------------------------------

type rpcRequestMsg struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
	ID      int             `json:"id"`
}

func call(t *testing.T, c *wsTestClient, req rpcRequestMsg) testResponse {
	t.Helper()
	payload, err := json.Marshal(req)
	require.NoError(t, err)
	require.NoError(t, c.writeText(payload))
	raw, err := c.readText()
	require.NoError(t, err)
	var resp testResponse
	require.NoError(t, json.Unmarshal(raw, &resp))
	return resp
}

func TestWebSocketEcho(t *testing.T) {
	c := dialWS(t, startTestServer(t))
	resp := call(t, c, rpcRequestMsg{
		JSONRPC: "2.0", Method: "echo",
		Params: json.RawMessage(`"hello"`), ID: 1,
	})
	assert.Nil(t, resp.Error)
	assert.JSONEq(t, `"hello"`, string(resp.Result))
	assert.JSONEq(t, `1`, string(resp.ID))
}

func TestWebSocketPingAndUnknownMethod(t *testing.T) {
	c := dialWS(t, startTestServer(t))

	resp := call(t, c, rpcRequestMsg{JSONRPC: "2.0", Method: "ping", ID: 2})
	assert.Nil(t, resp.Error)
	assert.JSONEq(t, `"pong"`, string(resp.Result))

	resp = call(t, c, rpcRequestMsg{JSONRPC: "2.0", Method: "nope", ID: 3})
	require.NotNil(t, resp.Error)
	assert.Equal(t, MethodNotFound, resp.Error.Code)
}

func TestHealth(t *testing.T) {
	srv := startTestServer(t)
	resp, err := http.Get(srv.URL + "/health")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	assert.Equal(t, "ok\n", string(body))
}

func TestRelayToolServed(t *testing.T) {
	// The snippet loads the Relay Tool from the WebSocket port:
	// GET /relay-tool.js must return the web-components app with
	// its version header.
	srv := startTestServer(t)
	resp, err := http.Get(srv.URL + "/relay-tool.js")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Contains(t, resp.Header.Get("Content-Type"), "javascript")
	assert.Equal(t, RelayToolVersion, resp.Header.Get("X-Relay-Tool-Version"))

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	js := string(body)
	assert.Contains(t, js, "relay-tool", "tool must define the <relay-tool> component")
	assert.Contains(t, js, "relay-echo-panel")
	assert.Contains(t, js, RelayToolVersion, "tool JS must carry its version")
}

func TestGUIServesSnippetForLiveAddress(t *testing.T) {
	// Non-default WS address: the page must show the snippet pointing
	// at the address the server actually listens on, not the default.
	url, err := startGUI("127.0.0.1", "127.0.0.1:9000")
	require.NoError(t, err)

	resp, err := http.Get(url + "/")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	page := string(body)
	assert.Contains(t, page, "developer console")
	assert.Contains(t, page, "wsEcho", "page must contain the client snippet")
	assert.Contains(t, page, RelayToolVersion,
		"snippet must be stamped with the served Relay Tool version")
	assert.NotContains(t, page, "__RELAY_TOOL_VERSION__",
		"the version placeholder must be rewritten at serve time")
	assert.Contains(t, page, "ws://127.0.0.1:9000")
	assert.NotContains(t, page, "8765",
		"snippet default address must be rewritten to the live address")
}

// --- Chat relay: fake Remote Server + end-to-end flow -----------------------

// startFakeRemote listens on a random port and answers every chat
// message with "re: <text>", like the real Remote Server's operator
// would — but deterministic, for tests.
func startFakeRemote(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		scanner := bufio.NewScanner(conn)
		for scanner.Scan() {
			var m remoteMessage
			if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
				continue
			}
			if m.Type == "msg" {
				reply, _ := json.Marshal(remoteMessage{
					Type: "msg", From: "remote", Text: "re: " + m.Text,
				})
				conn.Write(append(reply, '\n'))
			}
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestRelayChatEndToEnd(t *testing.T) {
	remotePort := startFakeRemote(t)
	c := dialWS(t, startTestServer(t))

	// Send before connecting is an error.
	resp := call(t, c, rpcRequestMsg{JSONRPC: "2.0", Method: "relay.send",
		Params: json.RawMessage(`{"text":"too early"}`), ID: 1})
	require.NotNil(t, resp.Error, "relay.send before connect must fail")

	// Connect to a dead port is an error too.
	resp = call(t, c, rpcRequestMsg{JSONRPC: "2.0", Method: "relay.connect",
		Params: json.RawMessage(`{"host":"127.0.0.1","port":1}`), ID: 2})
	require.NotNil(t, resp.Error, "relay.connect to a dead port must fail")

	resp = call(t, c, rpcRequestMsg{JSONRPC: "2.0", Method: "relay.connect",
		Params: json.RawMessage(fmt.Sprintf(`{"host":"127.0.0.1","port":%d}`, remotePort)), ID: 3})
	require.Nil(t, resp.Error)
	assert.Contains(t, string(resp.Result), "127.0.0.1")

	resp = call(t, c, rpcRequestMsg{JSONRPC: "2.0", Method: "relay.status", ID: 4})
	require.Nil(t, resp.Error)
	assert.Contains(t, string(resp.Result), `"connected"`)

	resp = call(t, c, rpcRequestMsg{JSONRPC: "2.0", Method: "relay.send",
		Params: json.RawMessage(`{"text":"hello remote"}`), ID: 5})
	require.Nil(t, resp.Error)

	// The fake remote's reply must arrive as a relay.message
	// notification (it may interleave with nothing else here).
	require.NoError(t, c.conn.SetReadDeadline(time.Now().Add(5*time.Second)))
	for {
		raw, err := c.readText()
		require.NoError(t, err, "waiting for the relay.message notification")
		var notif struct {
			Method string `json:"method"`
			Params struct {
				From string `json:"from"`
				Text string `json:"text"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &notif); err == nil && notif.Method == "relay.message" {
			assert.Equal(t, "remote", notif.Params.From)
			assert.Equal(t, "re: hello remote", notif.Params.Text)
			break
		}
	}

	resp = call(t, c, rpcRequestMsg{JSONRPC: "2.0", Method: "relay.disconnect", ID: 6})
	require.Nil(t, resp.Error)
	assert.Equal(t, `"ok"`, string(resp.Result))
}
