/**
 * websocket-relay — drop-in browser snippet (Step 1: Echo)
 *
 * Paste this whole file into a page (or load it with <script src="snippet.js">),
 * then:
 *
 *   const rpc = new WsRpc('ws://127.0.0.1:8765');
 *   await rpc.connect();
 *   const result = await rpc.call('echo', 'hello');
 *   console.log(result); // "hello"
 *
 *   // or with an object:
 *   await rpc.call('echo', { message: 'hello' }); // -> { message: 'hello' }
 *
 * No dependencies. Vanilla JS, Promises keyed by JSON-RPC id.
 * Pending-call lookup is O(1); ids increment monotonically.
 */
class WsRpc {
  constructor(url = 'ws://127.0.0.1:8765') {
    this.url = url;
    this.ws = null;
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve, reject}
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (event) => this._onMessage(event.data);
      this.ws.onclose = () => {
        for (const { reject } of this._pending.values()) {
          reject(new Error('WebSocket closed'));
        }
        this._pending.clear();
      };
    });
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    // Handle single responses (batch support can be added later)
    const responses = Array.isArray(msg) ? msg : [msg];
    for (const res of responses) {
      const pending = this._pending.get(res.id);
      if (!pending) continue;
      this._pending.delete(res.id);
      if (res.error) {
        const err = new Error(res.error.message || 'RPC error');
        err.code = res.error.code;
        err.data = res.error.data;
        pending.reject(err);
      } else {
        pending.resolve(res.result);
      }
    }
  }

  /** Send a JSON-RPC 2.0 request and await its result. */
  call(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected — call connect() first'));
    }
    const id = this._nextId++;
    const payload = { jsonrpc: '2.0', method, params, id };
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response). */
  notify(method, params) {
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  close() {
    this.ws?.close();
  }
}

// Convenience for the absolute simplest test in a console / page:
//   await wsEcho('hello')  // -> "hello"
let _defaultRpc = null;
async function wsEcho(message = 'hello') {
  if (!_defaultRpc) {
    _defaultRpc = new WsRpc('ws://127.0.0.1:8765');
    await _defaultRpc.connect();
  }
  return _defaultRpc.call('echo', message);
}

// Expose for <script> tag usage
if (typeof window !== 'undefined') {
  window.WsRpc = WsRpc;
  window.wsEcho = wsEcho;
}
