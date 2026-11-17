# websocket-relay

A WebSocket relay speaking **JSON-RPC 2.0**: the **Comms Shim**.

- **Server (localhostServer):** Go; the server itself uses only the standard library (the module's few dependencies are test-only)
- **Client:** a drop-in vanilla-JS snippet for any web page
- **GUI:** served by localhostServer on a random port (see How to run)

Version control: git. Changes are exchanged as patch series
(`git format-patch` / `git am`) — see `.agents/WORKFLOW.md`.

## Terminology

The names we use for the parts of this system:

- **Comms Shim** — the whole local system: a WebSocket server running
  on the user's own machine plus its GUI and client snippet, letting a
  web page talk to the user's localhost. ("Shim" because it's a thin
  layer dropped between the browser page and the local machine.)
- **localhostServer** — the server component of the Comms Shim. Runs
  on the user's localhost, accepts WebSocket connections from the
  client snippet, speaks JSON-RPC 2.0. Currently the Go program in
  `server/`, listening on `ws://127.0.0.1:8765`.
- **Client snippet** — the drop-in JavaScript (`client/snippet.js`)
  pasted into a web page or the browser developer console; it connects
  the page to localhostServer.
- **GUI** — localhostServer's web GUI, reachable at
  `http://localhost:<random port>`. The port is random (chosen at
  startup) and the full link is displayed on the command line when the
  server runs. For now the GUI is one simple page — "here's the code
  snippet to drop in your developer console", with the snippet code —
  and will eventually become a web app built with vanilla JS, CSS,
  HTML and standard web components.

## How to run

### Prerequisites

- Go 1.20 or newer (the module targets `go 1.20`)
- A clone of this repo

### Run localhostServer

```sh
cd websocket-relay
go run ./server
# or build once: go build -o websocket-relay ./server && ./websocket-relay
# options: -host 127.0.0.1 (default), -port 8765 (default, WebSocket port)
```

Startup prints both addresses — the GUI port is **random**, chosen
fresh on every run:

```
Comms Shim — localhostServer
  WebSocket (JSON-RPC 2.0): ws://127.0.0.1:8765
  GUI: http://127.0.0.1:51234        <- example; your port will differ
  methods: echo, ping
```

Leave it running; Ctrl+C stops it.

### Use the GUI

1. Open the printed GUI link in a browser on the same machine.
2. The page shows the client snippet with localhostServer's real
   address already filled in. Click **Copy snippet**.
3. On any web page, open the developer console (F12 / Cmd+Option+J),
   paste, and run: `await wsEcho('hello')` → `"hello"` comes back.

There is also a self-contained test page, `client/demo.html` — open
it in a browser on the same machine while the server runs; it
auto-connects and auto-echoes `"hello"`.

### Run the tests

```sh
go test ./...
```

Unit tests cover the JSON-RPC dispatcher directly; integration
tests run the real handler over a WebSocket connection and check
the GUI page. No server needs to be running first — the tests
start their own.

Drop-in snippet for your own page — see `client/snippet.js`:

```js
const rpc = new WsRpc('ws://127.0.0.1:8765');
await rpc.connect();
const result = await rpc.call('echo', 'hello');
console.log(result); // "hello"

// or the one-liner:
await wsEcho('hello'); // "hello"
```

## Protocol

JSON-RPC 2.0 over WebSocket text frames.

Request:
```json
{"jsonrpc": "2.0", "method": "echo", "params": "hello", "id": 1}
```
Success response:
```json
{"jsonrpc": "2.0", "result": "hello", "id": 1}
```
Error response (e.g. unknown method):
```json
{"jsonrpc": "2.0", "error": {"code": -32601, "message": "Method not found: …"}, "id": 1}
```

Methods:

| Method | Params | Result |
|---|---|---|
| `echo` | anything | params, verbatim |
| `ping` | — | `"pong"` |

Notifications (no `id`) get no response, per spec. Batch requests are supported.

## Layout

```
assets.go       — module-root package embedding client/snippet.js for the GUI
server/
  main.go       — entry point, WS listener, connection loop, startup banner
  websocket.go  — transport: RFC 6455 handshake + framing (stdlib only)
  rpc.go        — protocol: Dispatcher (Strategy registry) + echo/ping
  gui.go        — GUI listener (random port) + snippet page
  rpc_test.go   — dispatcher unit tests
  server_test.go — WebSocket + GUI integration tests
client/
  snippet.js    — drop-in WsRpc client class + wsEcho() helper
  demo.html     — self-contained test page
```

Design notes: transport and protocol are separate layers; adding a method is
one `Register(name, handler)` call — no transport changes. Dispatch is O(1)
per method lookup, O(n) in message size.

## Roadmap

- [x] Echo over JSON-RPC 2.0
- [x] GUI on a random port (link printed at startup); page shows the
      client snippet to drop into the dev console
- [ ] GUI grows into a full web app (vanilla JS/CSS/HTML + standard
      web components)
- [ ] Relay between connected clients (design TBD)
