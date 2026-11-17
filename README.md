# websocket-relay

A WebSocket relay speaking **JSON-RPC 2.0**, built step by step.

- **Server:** Go (standard library only — no external dependencies), on the MacBook Dev machine
- **Client:** a drop-in vanilla-JS snippet for any web page
- **Step 1 (current): Echo** — browser sends `hello`, server sends the same message back

## Where it lives

| Side | Path |
|---|---|
| Steve ↔ MacBook (Syncthing `projects`) | `~/Sync/projects/websocket-relay/` on the Mac |
| Muse VM (rsync staging) | `~/sync/projects/websocket-relay/` |
| MacBook Dev | same Syncthing path — build & run there |

Version control: this folder is a **git repo**. Commit as we go, step by step.

## Run the server (on the Mac)

Go is at `/usr/local/go/bin/go` on the MacBook (not on PATH in non-login shells):

```sh
cd ~/Sync/projects/websocket-relay
export PATH="$PATH:/usr/local/go/bin"
go run ./server                 # ws://127.0.0.1:8765
# or: go run ./server -port 9000
```

## Test it

Automated (from the VM or the Mac, server running):

```sh
python3 tests/test_client.py
# PASS  echo string 'hello': got='hello' expected='hello'
# PASS  echo object ...
# PASS  ping ...
# ALL PASS
```

In a browser (on the Mac, so `localhost` is the Mac):

1. Start the server as above
2. Open `client/demo.html` in a browser on the Mac
3. It auto-connects and auto-echoes `"hello"` on load, or type a message and hit **Send echo**

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

Methods in Step 1:

| Method | Params | Result |
|---|---|---|
| `echo` | anything | params, verbatim |
| `ping` | — | `"pong"` |

Notifications (no `id`) get no response, per spec. Batch requests are supported.

## Layout

```
server/
  main.go       — entry point, HTTP listener, connection loop
  websocket.go  — transport: RFC 6455 handshake + framing (stdlib only)
  rpc.go        — protocol: Dispatcher (Strategy registry) + echo/ping
client/
  snippet.js    — drop-in WsRpc client class + wsEcho() helper
  demo.html     — self-contained test page
tests/
  test_client.py — stdlib Python WebSocket client, end-to-end checks
```

Design notes: transport and protocol are separate layers; adding a method is
one `Register(name, handler)` call — no transport changes. Dispatch is O(1)
per method lookup, O(n) in message size.

## Roadmap

- [x] Step 1 — Echo
- [ ] Step 2 — TBD with Steve (relay between two clients? named rooms? …)
