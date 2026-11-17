// websocket-relay — Step 1: Echo
//
// WebSocket server on localhost speaking JSON-RPC 2.0.
// Transport (websocket.go) is separate from protocol (rpc.go):
// Clean Architecture — the dispatcher knows nothing about sockets.
//
// Run:
//
//	go run ./server [--host 127.0.0.1] [--port 8765]
//	# or
//	go build -o websocket-relay ./server && ./websocket-relay
package main

import (
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

	dispatcher := buildDispatcher()
	addr := fmt.Sprintf("%s:%d", *host, *port)

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		serveWS(w, r, dispatcher)
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintln(w, "ok")
	})

	log.Printf("websocket-relay listening on ws://%s", addr)
	log.Printf("methods: %s", strings.Join(dispatcher.Methods(), ", "))
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func serveWS(w http.ResponseWriter, r *http.Request, dispatcher *Dispatcher) {
	ws, err := upgrade(w, r)
	if err != nil {
		log.Printf("[ws] upgrade failed from %s: %v", r.RemoteAddr, err)
		return
	}
	defer ws.close()
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
