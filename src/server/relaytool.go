// relaytool.go — serves the Relay Tool, the versioned web-components
// app the client snippet loads into a page.
//
// The tool is served from the WebSocket port (same mux as /health)
// because that is the only address the snippet knows: it derives
// this URL from its WebSocket URL by swapping ws:// for http://.
package main

import (
	"net/http"

	relay "websocket-relay"
)

// RelayToolVersion is the version of the Relay Tool served here.
// Bump it whenever client/relay-tool.js changes; the version is
// sent in the X-Relay-Tool-Version header and shown in the tool's
// header. Keep it in step with VERSION in client/relay-tool.js.
const RelayToolVersion = "0.1.0"

// relayToolHandler serves the Relay Tool JavaScript.
func relayToolHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("X-Relay-Tool-Version", RelayToolVersion)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(relay.RelayToolJS))
}
