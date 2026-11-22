// localhostServer — the Comms Shim server.
//
// Since the MQTT migration, localhostServer is:
//
//   - an MQTT broker (embedded, mochi-mqtt/server) speaking
//     JSON-RPC 2.0 payloads — see mqttx for the topic conventions;
//   - the bridge to the Remote Server's broker (bridge.go);
//   - an HTTP asset server for the browser pieces the snippet
//     loads: /relay-tool.js and /mqtt.min.js (plus /health);
//   - the GUI server (gui.go), which hands out the snippet.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"

	relay "websocket-relay"
	"websocket-relay/jsonrpc"
	"websocket-relay/mqttx"
)

func main() {
	host := flag.String("host", "127.0.0.1", "bind host")
	port := flag.Int("port", 8765, "HTTP asset port (/health, /relay-tool.js, /mqtt.min.js)")
	mqttTCP := flag.Int("mqtt-tcp", 1883, "MQTT TCP broker port")
	mqttWS := flag.Int("mqtt-ws", 8083, "MQTT-over-WebSocket broker port")
	remoteHost := flag.String("remote-host", "",
		"Remote Server host for the bridge (empty = bridge off)")
	remoteMQTTPort := flag.Int("remote-mqtt-port", 1883, "Remote Server MQTT TCP port")
	flag.Parse()

	tcpAddr := fmt.Sprintf("%s:%d", *host, *mqttTCP)
	wsAddr := fmt.Sprintf("%s:%d", *host, *mqttWS)
	broker, err := mqttx.NewBroker(tcpAddr, wsAddr)
	if err != nil {
		log.Fatalf("broker: %v", err)
	}

	hook := &bridgeHook{}
	if err := broker.AddHook(hook, nil); err != nil {
		log.Fatalf("bridge hook: %v", err)
	}
	dispatcher := jsonrpc.BuildDispatcher()
	if err := mqttx.RespondRPC(broker, "localhost", dispatcher); err != nil {
		log.Fatalf("rpc responder: %v", err)
	}

	bridgeState := "off"
	if *remoteHost != "" {
		remoteURL := fmt.Sprintf("tcp://%s:%d", *remoteHost, *remoteMQTTPort)
		startUplink(broker, remoteURL, hook) // retries in the background
		bridgeState = "on -> " + remoteURL
	}

	go func() {
		if err := broker.Serve(); err != nil {
			log.Fatalf("broker serve: %v", err)
		}
	}()

	brokerURL := fmt.Sprintf("ws://%s:%d", *host, *mqttWS)
	assetBase := fmt.Sprintf("http://%s:%d", *host, *port)
	guiURL, err := startGUI(*host, brokerURL, assetBase)
	if err != nil {
		log.Printf("[gui] failed to start: %v", err)
		guiURL = "(unavailable)"
	}

	fmt.Println("Comms Shim — localhostServer")
	fmt.Printf("  MQTT broker: tcp %s, ws %s\n", tcpAddr, wsAddr)
	fmt.Printf("  Assets: %s (/relay-tool.js, /mqtt.min.js)\n", assetBase)
	fmt.Printf("  GUI: %s\n", guiURL)
	fmt.Printf("  Bridge to Remote Server: %s\n", bridgeState)
	fmt.Printf("  methods (target localhost): %v\n", dispatcher.Methods())

	assetAddr := fmt.Sprintf("%s:%d", *host, *port)
	log.Fatal(http.ListenAndServe(assetAddr, buildMux()))
}

// buildMux wires the HTTP asset routes. Extracted from main so
// tests can serve the real handler (see server_test.go).
func buildMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/relay-tool.js", relayToolHandler)
	mux.HandleFunc("/mqtt.min.js", mqttJSHandler)
	return mux
}

// mqttJSHandler serves the vendored MQTT.js browser build — the
// snippet's fallback when the CDN copy can't be loaded.
func mqttJSHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(relay.MQTTJS))
}
