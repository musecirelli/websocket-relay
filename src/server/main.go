// localhostServer — the server component of the Comms Shim.
//
// WebSocket server on localhost speaking JSON-RPC 2.0, plus the
// Comms Shim GUI on a separate random port (gui.go).
// Transport (websocket.go) is separate from protocol (rpc.go):
// Clean Architecture — the dispatcher knows nothing about sockets.
//
// Run (from the repo root):
//
//	make run          # debug: race detector on
//	make run-release  # production build, then run
//	# or, from src/: go run ./server [--host 127.0.0.1] [--port 8765]
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strings"
)

func main() {
	host := flag.String("host", "127.0.0.1", "listen host (localhost only by default)")
	port := flag.Int("port", 8765, "listen port")
	flag.Parse()

	addr := fmt.Sprintf("%s:%d", *host, *port)
	mux := buildMux()

	guiURL, err := startGUI(*host, addr)
	if err != nil {
		// The shim still works without its GUI; say so and continue.
		log.Printf("[gui] failed to start: %v", err)
		guiURL = "(unavailable)"
	}

	fmt.Println("Comms Shim — localhostServer")
	fmt.Printf("  WebSocket (JSON-RPC 2.0): ws://%s\n", addr)
	fmt.Printf("  GUI: %s\n", guiURL)
	fmt.Printf("  methods: %s\n", strings.Join(buildSessionDispatcher(newSession(nil)).Methods(), ", "))
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

// session is one browser's WebSocket connection: its dispatcher
// (with the relay methods bound to its own relay connection) and
// its outbound notification channel back to the browser.
type session struct {
	ws    *wsConn
	relay *relayClient
}

func newSession(ws *wsConn) *session {
	s := &session{ws: ws, relay: &relayClient{}}
	s.relay.notify = s.notify
	return s
}

// notify pushes a JSON-RPC notification (no id) to the browser.
// Safe to call from any goroutine; wsConn serializes frame writes.
func (s *session) notify(method string, params any) {
	if s.ws == nil {
		return
	}
	paramsJSON, err := json.Marshal(params)
	if err != nil {
		return
	}
	frame, err := json.Marshal(struct {
		JSONRPC string          `json:"jsonrpc"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
	}{"2.0", method, paramsJSON})
	if err != nil {
		return
	}
	log.Printf("[rpc] notify %s", string(frame))
	if err := s.ws.writeFrame(opText, frame); err != nil {
		log.Printf("[ws] notify write error: %v", err)
	}
}

// buildMux wires the HTTP routes served on the WebSocket port: the
// WebSocket endpoint itself, /health, and /relay-tool.js (the Relay
// Tool the snippet loads). Extracted from main so tests can serve
// the real handler (see server_test.go).
func buildMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		serveWS(w, r)
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("GET /relay-tool.js", relayToolHandler)
	return mux
}

func serveWS(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrade(w, r)
	if err != nil {
		log.Printf("[ws] upgrade failed from %s: %v", r.RemoteAddr, err)
		return
	}
	// One session per browser connection: its own dispatcher, with
	// the relay methods bound to its own Remote Server connection.
	sess := newSession(ws)
	dispatcher := buildSessionDispatcher(sess)
	defer func() {
		sess.relay.disconnect()
		ws.close()
	}()
	log.Printf("[ws] connect %s", r.RemoteAddr)

	// Accumulate fragmented messages until a final text/binary frame.
	var fragments []byte
	fragmenting := false

	for {
		opcode, payload, err := ws.readFrame()
		if err != nil {
			log.Printf("[ws] read error %s: %v", r.RemoteAddr, err)
			break
		}
		switch opcode {
		case opClose:
			ws.writeFrame(opClose, []byte{})
			log.Printf("[ws] disconnect %s", r.RemoteAddr)
			return
		case opPing:
			ws.writeFrame(opPong, payload)
		case opPong:
			// ignore
		case opText, opBinary:
			fragments = append(fragments[:0], payload...)
			fragmenting = false
			_ = fragmenting
			handleMessage(ws, dispatcher, fragments)
		case opContinuation:
			fragments = append(fragments, payload...)
			// Step 1 messages are small and unfragmented in practice;
			// a FIN check would complete this — kept simple for now.
			handleMessage(ws, dispatcher, fragments)
		}
	}
}

func handleMessage(ws *wsConn, dispatcher *Dispatcher, payload []byte) {
	log.Printf("[rpc] recv %s", string(payload))
	// Copy: dispatcher may retain raw slices; payload buffer is reused.
	msg := make([]byte, len(payload))
	copy(msg, payload)
	if resp := dispatcher.Dispatch(msg); resp != nil {
		log.Printf("[rpc] send %s", string(resp))
		if err := ws.writeFrame(opText, resp); err != nil {
			log.Printf("[ws] write error: %v", err)
		}
	}
}
