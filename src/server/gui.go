// gui.go — the Comms Shim GUI, served by localhostServer.
//
// A separate HTTP listener on an OS-assigned random port (":0").
// For now the GUI is a single page: "here's the code snippet to drop
// in your developer console", with the snippet code and a copy
// button. Vanilla HTML/CSS/JS only — no frameworks. It will grow
// into a web-components app later (see README Terminology: GUI).
package main

import (
	"html/template"
	"log"
	"net"
	"net/http"
	"strings"

	relay "websocket-relay"
)

// Placeholders baked into client/snippet.js; the GUI stamps in
// the live values, so a copied snippet works as-is even when the
// server was started with non-default ports. All three are string
// literals in the snippet and survive Closure compilation.
const (
	brokerPlaceholder = "__BROKER_URL__" // MQTT-over-WebSocket broker URL
	assetPlaceholder  = "__ASSET_BASE__" // HTTP base for /relay-tool.js, /mqtt.min.js

	// toolVersionPlaceholder: the Relay Tool version this server
	// actually serves (RelayToolVersion), so the snippet knows
	// which versioned tool it is asking for.
	toolVersionPlaceholder = "__RELAY_TOOL_VERSION__"
)

// startGUI starts the GUI listener on host with a random port and
// returns its URL, e.g. "http://127.0.0.1:51234".
func startGUI(host, brokerURL, assetBase string) (string, error) {
	ln, err := net.Listen("tcp", host+":0")
	if err != nil {
		return "", err
	}
	g := &gui{brokerURL: brokerURL, assetBase: assetBase}
	mux := http.NewServeMux()
	mux.HandleFunc("/", g.page)
	go func() {
		if err := http.Serve(ln, mux); err != nil {
			log.Printf("[gui] serve error: %v", err)
		}
	}()
	return "http://" + ln.Addr().String(), nil
}

type gui struct {
	brokerURL string // MQTT-over-WebSocket URL, e.g. "ws://127.0.0.1:8083"
	assetBase string // HTTP asset base, e.g. "http://127.0.0.1:8765"
}

// page renders the snippet page. Rendering is O(n) in snippet size.
func (g *gui) page(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	// The GUI hands out the Closure-compiled snippet with three
	// serve-time rewrites (all string literals, untouched by
	// compilation): the broker URL, the asset base, and the Relay
	// Tool version this server serves.
	snippet := strings.ReplaceAll(relay.ClientSnippetMin, brokerPlaceholder, g.brokerURL)
	snippet = strings.ReplaceAll(snippet, assetPlaceholder, g.assetBase)
	snippet = strings.ReplaceAll(snippet, toolVersionPlaceholder, RelayToolVersion)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := guiPage.Execute(w, map[string]string{
		"BrokerURL": g.brokerURL,
		"Snippet":   snippet,
	}); err != nil {
		log.Printf("[gui] render error: %v", err)
	}
}

var guiPage = template.Must(template.New("gui").Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Comms Shim — localhostServer</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 52rem; padding: 0 1rem; }
  code, pre { font-family: ui-monospace, Menlo, monospace; }
  pre { background: #f4f4f4; border: 1px solid #ddd; border-radius: 6px;
        padding: 1rem; overflow-x: auto; font-size: 0.82rem; }
  button { font-size: 1rem; padding: 0.4rem 1rem; cursor: pointer; }
  .addr { background: #eef6ee; padding: 0.2rem 0.4rem; border-radius: 4px; }
</style>
</head>
<body>
<h1>Comms Shim — localhostServer</h1>
<p>localhostServer is running. MQTT broker (JSON-RPC 2.0 payloads):
   <code class="addr">{{.BrokerURL}}</code></p>

<h2>Drop this into your developer console</h2>
<ol>
  <li>Open any web page, then open its developer console
      (F12, or Cmd+Option+J).</li>
  <li>Copy the snippet below and paste it into the console.</li>
  <li>The <strong>Relay Tool</strong> window appears on the page —
      pick a function on the left (Echo, Chat), type, and Send.
      In the console you can also try
      <code>await wsEcho('hello')</code>.</li>
</ol>
<p>The snippet is minified (Closure Compiler) — the readable source
   is <code>src/client/snippet.js</code> in the repo. All it does is
   connect and load the Relay Tool from localhostServer.</p>
<p><button id="copy" type="button">Copy snippet</button></p>
<pre id="snippet">{{.Snippet}}</pre>

<script>
  document.getElementById('copy').addEventListener('click', async () => {
    const btn = document.getElementById('copy');
    try {
      await navigator.clipboard.writeText(
        document.getElementById('snippet').textContent);
      btn.textContent = 'Copied!';
    } catch {
      btn.textContent = 'Copy failed — select the text manually';
    }
    setTimeout(() => { btn.textContent = 'Copy snippet'; }, 2000);
  });
</script>
</body>
</html>
`))
