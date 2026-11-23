// bridge.go — the bridge from localhostServer's broker to the
// Remote Server's broker.
//
// localhostServer initiates the bridge (Steve's design: it
// publishes messages to the Remote Server). Two flows, both QoS 0:
//
//   - Out (hook): when a local client publishes on chat/<user> or
//     shim/rpc/remote/<clientId>, the bridge hook republishes it
//     to the Remote broker over the uplink client.
//   - Back (uplink subscription): the uplink subscribes on the
//     Remote broker to chat/+ and shim/clients/+/rpc and injects
//     what arrives into the local broker as inline publishes.
//
// Loop-freedom: the hook never forwards publishes that originated
// from the broker's inline client — which is exactly how the
// back-flow (and RPC responses) enter the local broker.
package main

import (
	"log"
	"strings"
	"time"

	mqtt "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/packets"
	paho "github.com/eclipse/paho.mqtt.golang"
)

type bridgeHook struct {
	mqtt.HookBase
	uplink paho.Client // set after connect; nil while the bridge is down
}

func (h *bridgeHook) ID() string           { return "bridge-uplink" }
func (h *bridgeHook) Provides(b byte) bool { return b == mqtt.OnPublish }

func (h *bridgeHook) OnPublish(cl *mqtt.Client, pk packets.Packet) (packets.Packet, error) {
	if cl.ID == mqtt.InlineClientId {
		return pk, nil // our own injection — never forward
	}
	if h.uplink == nil || !h.uplink.IsConnected() {
		return pk, nil
	}
	if isChatTopic(pk.TopicName) || strings.HasPrefix(pk.TopicName, "shim/rpc/remote/") {
		h.uplink.Publish(pk.TopicName, 0, false, pk.Payload)
	}
	return pk, nil
}

// isChatTopic reports whether t is exactly chat/<user>.
func isChatTopic(t string) bool {
	parts := strings.Split(t, "/")
	return len(parts) == 2 && parts[0] == "chat" && parts[1] != ""
}

// startUplink connects the bridge in the background: it retries
// every few seconds until the Remote Server is reachable (start
// order of the two servers must not matter), then hands the
// client to the hook. Later drops are handled by the client's
// auto-reconnect; subscriptions are (re)made on every connect.
func startUplink(local *mqtt.Server, remoteURL string, hook *bridgeHook) {
	go func() {
		for {
			c, err := dialUplink(local, remoteURL)
			if err == nil {
				hook.uplink = c
				return
			}
			log.Printf("[bridge] uplink to %s failed: %v (retrying in 5s)", remoteURL, err)
			time.Sleep(5 * time.Second)
		}
	}()
}

// dialUplink makes one connection attempt to the Remote Server
// broker and wires the back-flow into the local broker.
func dialUplink(local *mqtt.Server, remoteURL string) (paho.Client, error) {
	opts := paho.NewClientOptions().AddBroker(remoteURL).SetClientID("localhostserver-bridge")
	opts.SetAutoReconnect(true)
	opts.SetOnConnectHandler(func(c paho.Client) {
		for _, filter := range []string{"chat/+", "shim/clients/+/rpc"} {
			if t := c.Subscribe(filter, 0, nil); t.Wait() && t.Error() != nil {
				log.Printf("[bridge] subscribe %s: %v", filter, t.Error())
			}
		}
		log.Printf("[bridge] uplink connected to %s", remoteURL)
	})
	opts.SetDefaultPublishHandler(func(c paho.Client, m paho.Message) {
		if err := local.Publish(m.Topic(), m.Payload(), false, 0); err != nil {
			log.Printf("[bridge] inject %s locally: %v", m.Topic(), err)
		}
	})
	c := paho.NewClient(opts)
	if t := c.Connect(); t.Wait() && t.Error() != nil {
		return nil, t.Error()
	}
	return c, nil
}
