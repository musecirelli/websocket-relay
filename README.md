# websocket-relay

A WebSocket relay speaking **JSON-RPC 2.0**: the **Comms Shim**.

- **Server (localhostServer):** Go; the server itself uses only the standard library (the module's few dependencies are test-only)
- **Client:** a drop-in vanilla-JS snippet for any web page
- **GUI:** served by localhostServer on a random port (see How to run)

Version control: git, hosted on GitHub — canonical repo
`scirelli/websocket-relay`; see `.agents/WORKFLOW.md`.

## Terminology

The names we use for the parts of this system:

- **Comms Shim** — the whole local system: a WebSocket server running
  on the user's own machine plus its GUI and client snippet, letting a
  web page talk to the user's localhost. ("Shim" because it's a thin
  layer dropped between the browser page and the local machine.)
- **localhostServer** — the server component of the Comms Shim. Runs
  on the user's localhost, accepts WebSocket connections from the
  client snippet, speaks JSON-RPC 2.0. Currently the Go program in
  `src/server/`, listening on `ws://127.0.0.1:8765`.
- **Client snippet** — the drop-in JavaScript (`src/client/snippet.js`)
  pasted into a web page or the browser developer console. It is a
  *loader*: it connects the page to localhostServer and loads the
  Relay Tool from it. The GUI hands it out minified (Closure
  Compiler; see the Relay Tool section).
- **Relay Tool** — the versioned web-components app the snippet loads
  from localhostServer (`GET /relay-tool.js` on the WebSocket port).
  A floating window on the host page: a function list on the left,
  the selected function's panel on the right.
- **GUI** — localhostServer's web GUI, reachable at
  `http://localhost:<random port>`. The port is random (chosen at
  startup) and the full link is displayed on the command line when the
  server runs. For now the GUI is one simple page — "here's the code
  snippet to drop in your developer console", with the snippet code —
  and will eventually become a web app built with vanilla JS, CSS,
  HTML and standard web components.

## How to run

### Prerequisites

- The toolchains pinned in `mise.toml`. With
  [mise](https://mise.jdx.dev): run `mise install` in the repo root —
  it installs Go (currently 1.27.4) plus the build-time-only tools
  (Node, Java, Closure Compiler) used to compile the client snippet.
  Without mise, install Go 1.27 or newer from go.dev; the compiled
  snippet is committed, so Go alone is enough unless you edit
  `src/client/snippet.js`. (Older Go versions, e.g. 1.22, produce
  binaries current macOS refuses to run: `dyld: missing LC_UUID`.)
- A clone of this repo

### Build and run localhostServer

The Go module lives in `src/`; all build artifacts go to `build/`.
The Makefile at the repo root wraps both modes (`make help` lists
every target with its description):

```sh
# Debugging — race detector on, optimizations off
make run            # build in memory and run
make build          # or just build: build/debug/websocket-relay

# Production — static (CGO off), trimmed and stripped
make build-release  # build/release/websocket-relay
make run-release    # build it and run it

# Server options (pass to the binary, or after `go run`):
#   -host 127.0.0.1 (default)   -port 8765 (default, WebSocket port)
./build/release/websocket-relay -port 9000
```

Without make, the plain Go commands work from inside `src/`
(e.g. `go run ./server`). `make clean` empties `build/`.

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
2. The page shows the client snippet (minified) with localhostServer's
   real address already filled in. Click **Copy snippet**.
3. On any web page, open the developer console (F12 / Cmd+Option+J)
   and paste. The snippet connects and loads the Relay Tool — its
   window appears on the page. Pick **Echo**, type a message, Send.
   From the console, `await wsEcho('hello')` also works.

There is also a demo page, `src/client/demo.html` — open it in a
browser on the same machine while the server runs; it loads the
snippet the same way a console paste does and the Relay Tool
appears.

### Run the tests

```sh
make test           # or: cd src && go test ./...
```

Unit tests cover the JSON-RPC dispatcher directly; integration
tests run the real handler over a WebSocket connection and check
the GUI page. No server needs to be running first — the tests
start their own.

For your own page, the snippet does everything on paste; its API
after loading (see `src/client/snippet.js`):

```js
CommsShim.rpc            // the shared WsRpc connection
await wsEcho('hello');   // -> "hello"
const rpc = new WsRpc('ws://127.0.0.1:8765');  // or your own connection
await rpc.connect();
await rpc.call('echo', 'hello');
```

## The Relay Tool

The Relay Tool is a small web-components app served by
localhostServer at `GET /relay-tool.js` (WebSocket port), versioned
(`X-Relay-Tool-Version` header; the version also shows in the tool's
header). The client snippet — itself just a loader — fetches and
evaluates it; the loader is infrastructure and is not one of the
tool's functions.

Components (all vanilla custom elements; communication via custom
elements, `data-` attributes, and CustomEvents; animations in CSS):

- `<relay-tool>` — the floating window: drag by the header, resize
  by the corner (CSS `resize`), close with ×.
- `<relay-function-list>` — left panel listing the functions from a
  registry; clicking one marks it active and fires
  `relay-function-select`.
- `<relay-echo-panel>` — the Echo function: text field, Send button,
  readonly log with every echo appended.

Adding a function = one entry in the registry in
`src/client/relay-tool.js` plus one panel component — the same
Registry pattern as the server's method Dispatcher.

**Snippet compilation:** the GUI hands out the snippet compiled by
Google Closure Compiler (`src/client/snippet.min.js`, committed).
`make` recompiles it when `snippet.js` changes, via the mise task
`build-snippet`; if the compiler isn't installed at that point,
make stops and asks you to run `mise install`.

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
Makefile        — build/run/test entry points (debug + production); `make help` documents them
mise.toml       — pinned tools (Go; Node/Java/Closure for the snippet build) + mise tasks
src/            — the Go module
  go.mod, go.sum
  assets.go     — module-root package embedding the client files
  server/
    main.go       — entry point, WS listener, connection loop, startup banner
    websocket.go  — transport: RFC 6455 handshake + framing (stdlib only)
    rpc.go        — protocol: Dispatcher (Strategy registry) + echo/ping
    gui.go        — GUI listener (random port) + snippet page
    relaytool.go  — serves the Relay Tool at /relay-tool.js (versioned)
    rpc_test.go   — dispatcher unit tests
    server_test.go — WebSocket + GUI + Relay Tool integration tests
  client/
    snippet.js      — the loader snippet (source): WsRpc + CommsShim loader
    snippet.min.js  — snippet compiled by Closure Compiler (committed; rebuilt by make)
    relay-tool.js   — the Relay Tool web-components app (served by localhostServer)
    demo.html       — demo page: loads the snippet like a console paste
build/          — build artifacts and executables (generated, gitignored)
  debug/          make build
  release/        make build-release
```

Design notes: transport and protocol are separate layers; adding a method is
one `Register(name, handler)` call — no transport changes. Dispatch is O(1)
per method lookup, O(n) in message size.

## Roadmap

- [x] Echo over JSON-RPC 2.0
- [x] GUI on a random port (link printed at startup); page shows the
      client snippet to drop into the dev console
- [x] Snippet compiled with Closure Compiler (mise task); GUI hands
      out the minified form
- [x] Relay Tool v0.1.0: versioned web-components window served by
      localhostServer, loaded by the snippet; Echo panel
- [ ] GUI grows into a full web app (vanilla JS/CSS/HTML + standard
      web components)
- [ ] More Relay Tool functions
- [ ] Relay between connected clients (design TBD)
