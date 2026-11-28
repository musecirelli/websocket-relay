// Package mqttx wires the Comms Shim's MQTT layer: an embedded
// broker (mochi-mqtt/server) plus the JSON-RPC 2.0 conventions the
// shim runs over MQTT.
//
// Conventions (QoS 0 everywhere; chat is not retained):
//
//   - RPC requests are published to shim/rpc/<target>/<clientId>
//     with a JSON-RPC 2.0 request as the payload; the target server
//     answers on shim/clients/<clientId>/rpc. Correlation is the
//     JSON-RPC id, as usual.
//   - Chat is topics chat/<username>: subscribe to your own topic;
//     to message someone, publish a chat.message JSON-RPC
//     notification (params {from, text}) to their topic.
//   - Script delivery is topics scripts/<username>: subscribe to
//     your own topic; a script arrives as a script.deliver JSON-RPC
//     notification (params {from, name, description, script}).
//   - The Assistant function uses topics assistant/<username>/...:
//     a snapshot request is an assistant.snapshot JSON-RPC
//     notification on assistant/<username>/request; the panel
//     sends the answer — a begin/dom/console/end message
//     sequence on assistant/<username>/snapshot — only after
//     the user approves the request in the panel, or a single
//     {kind: "denied"} message if they refuse. Streamed console
//     entries are published as bare JSON on
//     assistant/<username>/console.
package mqttx

import (
	"encoding/json"
	"log"
	"strings"

	mqtt "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/hooks/auth"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/mochi-mqtt/server/v2/packets"

	"websocket-relay/jsonrpc"
)

// NewBroker creates a broker with TCP and WebSocket listeners at
// the given addresses (either may be "" to skip that listener).
// The inline client is enabled: the owning server uses it to
// publish and subscribe as itself.
func NewBroker(tcpAddr, wsAddr string) (*mqtt.Server, error) {
	srv := mqtt.New(&mqtt.Options{InlineClient: true})
	if err := srv.AddHook(new(auth.AllowHook), nil); err != nil {
		return nil, err
	}
	if tcpAddr != "" {
		if err := srv.AddListener(listeners.NewTCP(listeners.Config{
			ID: "tcp", Address: tcpAddr,
		})); err != nil {
			return nil, err
		}
	}
	if wsAddr != "" {
		if err := srv.AddListener(listeners.NewWebsocket(listeners.Config{
			ID: "ws", Address: wsAddr,
		})); err != nil {
			return nil, err
		}
	}
	return srv, nil
}

// RespondRPC makes srv answer JSON-RPC requests published to
// shim/rpc/<target>/<clientId> through dispatcher d, publishing
// each response to shim/clients/<clientId>/rpc. Notifications
// (Dispatch returns nil) get no response, per JSON-RPC.
func RespondRPC(srv *mqtt.Server, target string, d *jsonrpc.Dispatcher) error {
	filter := "shim/rpc/" + target + "/+"
	return srv.Subscribe(filter, 1, func(cl *mqtt.Client, sub packets.Subscription, pk packets.Packet) {
		parts := strings.Split(pk.TopicName, "/")
		clientID := parts[len(parts)-1]
		resp := d.Dispatch(pk.Payload)
		if resp == nil {
			return
		}
		replyTopic := "shim/clients/" + clientID + "/rpc"
		if err := srv.Publish(replyTopic, resp, false, 0); err != nil {
			log.Printf("[mqttx] rpc reply to %s failed: %v", replyTopic, err)
		}
	})
}

// ChatMethod is the JSON-RPC method of a chat message notification.
const ChatMethod = "chat.message"

type chatParams struct {
	From string `json:"from"`
	Text string `json:"text"`
}

// ChatPayload builds the JSON-RPC 2.0 notification for one chat
// message.
func ChatPayload(from, text string) []byte {
	frame, _ := json.Marshal(struct {
		JSONRPC string     `json:"jsonrpc"`
		Method  string     `json:"method"`
		Params  chatParams `json:"params"`
	}{"2.0", ChatMethod, chatParams{From: from, Text: text}})
	return frame
}

// ParseChat extracts (from, text) from a chat.message payload.
func ParseChat(payload []byte) (from, text string, ok bool) {
	var frame struct {
		Method string     `json:"method"`
		Params chatParams `json:"params"`
	}
	if err := json.Unmarshal(payload, &frame); err != nil || frame.Method != ChatMethod {
		return "", "", false
	}
	return frame.Params.From, frame.Params.Text, true
}

// PublishChat sends one chat message to user `to` on srv's broker.
func PublishChat(srv *mqtt.Server, to, from, text string) error {
	return srv.Publish("chat/"+to, ChatPayload(from, text), false, 0)
}

// SubscribeChat calls fn for every chat message addressed to user.
func SubscribeChat(srv *mqtt.Server, user string, fn func(from, text string)) error {
	return srv.Subscribe("chat/"+user, 2, func(cl *mqtt.Client, sub packets.Subscription, pk packets.Packet) {
		if from, text, ok := ParseChat(pk.Payload); ok {
			fn(from, text)
		}
	})
}
