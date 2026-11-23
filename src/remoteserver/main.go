// Remote Server — the far end of the Comms Shim.
//
// An MQTT broker (embedded, mochi-mqtt/server) plus this program's
// own functions on top of it:
//
//   - It answers JSON-RPC commands addressed to target "remote"
//     (shim/rpc/remote/<clientId>) with the shared Dispatcher
//     (echo, ping) — see mqttx for the topic conventions.
//   - It is chat user "remote": messages published to chat/remote
//     are logged, and lines from the operator console are
//     published back as chat messages to whoever wrote last
//     (default: "steve"). The operator console is stdin, or the
//     file/FIFO named by -console (reopened on EOF, so a detached
//     server can be fed one writer session at a time:
//     `printf 'hi\n' > /path/to/fifo`).
//
// Run (from the repo root): make run-remote
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"sync"
	"time"

	mqtt "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/packets"

	"websocket-relay/jsonrpc"
	"websocket-relay/mqttx"
)

// logHook logs broker connects/disconnects for the operator.
type logHook struct{ mqtt.HookBase }

func (h *logHook) ID() string               { return "operator-log" }
func (h *logHook) Provides(b byte) bool     { return b == mqtt.OnConnect || b == mqtt.OnDisconnect }
func (h *logHook) OnConnect(cl *mqtt.Client, pk packets.Packet) error {
	log.Printf("[mqtt connect] %s", cl.ID)
	return nil
}
func (h *logHook) OnDisconnect(cl *mqtt.Client, err error, expire bool) {
	log.Printf("[mqtt disconnect] %s", cl.ID)
}

// operator tracks who to reply to: the last chat sender.
type operator struct {
	mu       sync.Mutex
	lastFrom string
}

func (o *operator) saw(from string) {
	o.mu.Lock()
	o.lastFrom = from
	o.mu.Unlock()
}

func (o *operator) replyTo() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.lastFrom
}

func main() {
	port := flag.Int("port", 1883, "MQTT TCP listen port (all interfaces)")
	wsPort := flag.Int("ws-port", 8083, "MQTT-over-WebSocket listen port (all interfaces)")
	console := flag.String("console", "",
		"read operator lines from this file/FIFO instead of stdin (reopened on EOF)")
	flag.Parse()

	broker, err := mqttx.NewBroker(fmt.Sprintf(":%d", *port), fmt.Sprintf(":%d", *wsPort))
	if err != nil {
		log.Fatalf("broker: %v", err)
	}
	if err := broker.AddHook(new(logHook), nil); err != nil {
		log.Fatalf("hook: %v", err)
	}
	if err := mqttx.RespondRPC(broker, "remote", jsonrpc.BuildDispatcher()); err != nil {
		log.Fatalf("rpc responder: %v", err)
	}

	op := &operator{lastFrom: "steve"}
	if err := mqttx.SubscribeChat(broker, "remote", func(from, text string) {
		op.saw(from)
		log.Printf("[chat] %s: %s", from, text)
	}); err != nil {
		log.Fatalf("chat subscribe: %v", err)
	}

	go func() {
		if err := broker.Serve(); err != nil {
			log.Fatalf("serve: %v", err)
		}
	}()

	fmt.Printf("Remote Server — MQTT broker tcp :%d, ws :%d\n", *port, *wsPort)
	fmt.Println("Chat user \"remote\". Type a line and press Enter to reply to the last sender. Ctrl+C stops.")

	if *console != "" {
		operatorFile(broker, op, *console)
	} else {
		operatorLines(broker, op, os.Stdin)
	}
}

// operatorFile reads operator lines from a file/FIFO, reopening it
// on EOF so detached writer sessions can come and go.
func operatorFile(broker *mqtt.Server, op *operator, path string) {
	for {
		f, err := os.Open(path)
		if err != nil {
			log.Printf("console %s: %v (retrying)", path, err)
			time.Sleep(2 * time.Second)
			continue
		}
		operatorLines(broker, op, f)
		f.Close()
	}
}

func operatorLines(broker *mqtt.Server, op *operator, r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		text := scanner.Text()
		if text == "" {
			continue
		}
		to := op.replyTo()
		log.Printf("[remote -> %s] %s", to, text)
		if err := mqttx.PublishChat(broker, to, "remote", text); err != nil {
			log.Printf("publish: %v", err)
		}
	}
}
