/**
 * Comms Shim — client snippet (loader).
 *
 * Paste this whole file into a page's developer console (or load it
 * with <script src="snippet.js">). It connects to localhostServer,
 * asks it for the Relay Tool, and the tool window appears on the
 * page. Nothing else to do.
 *
 * What it exposes on window:
 *   CommsShim  — { rpc, loadScript, loadRelayTool, connect,
 *                  serverUrl, toolVersion }
 *   WsRpc      — the JSON-RPC 2.0 client class (used by the tool)
 *   wsEcho     — convenience: await wsEcho('hello') -> "hello"
 *
 * The loader (CommsShim.loadScript) is infrastructure: it is not
 * one of the Relay Tool's listed functions.
 *
 * No dependencies. Vanilla JS. Pending-call lookup is O(1);
 * JSON-RPC ids increment monotonically.
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

/**
 * CommsShim — the loader. Owns the shared connection to
 * localhostServer and loads JavaScript from it (the Relay Tool
 * today; anything else the server offers later).
 */
const CommsShim = {
  // Rewritten by the GUI to localhostServer's live address when the
  // snippet is copied from the GUI page.
  serverUrl: 'ws://127.0.0.1:8765',
  rpc: null,         // shared WsRpc, set by connect()
  toolVersion: null, // set by the Relay Tool when it loads

  /** HTTP base of localhostServer (ws:// -> http://). */
  get httpBase() {
    return this.serverUrl.replace(/^ws/, 'http');
  },

  /**
   * Load and evaluate a JavaScript file from url. Resolves once
   * the script has run. This is the JS loader the Relay Tool is
   * fetched with; it is not itself a tool function.
   */
  loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${url}`));
      document.head.appendChild(script);
    });
  },

  /** Connect the shared WebSocket (once) and return the WsRpc. */
  async connect() {
    if (!this.rpc) {
      this.rpc = new WsRpc(this.serverUrl);
      await this.rpc.connect();
    }
    return this.rpc;
  },

  /** Ask localhostServer for the Relay Tool and show it. */
  async loadRelayTool() {
    await this.loadScript(`${this.httpBase}/relay-tool.js`);
  },

  /** Connect, then load the Relay Tool. Runs automatically below. */
  async start() {
    await this.connect();
    await this.loadRelayTool();
    console.log(`[Comms Shim] Relay Tool v${this.toolVersion} ready`);
  },
};

// Convenience for the simplest test in a console:
//   await wsEcho('hello')  // -> "hello"   (uses the shared connection)
async function wsEcho(message = 'hello') {
  const rpc = await CommsShim.connect();
  return rpc.call('echo', message);
}

// Expose for <script> tag usage, then start automatically.
if (typeof window !== 'undefined') {
  window.WsRpc = WsRpc;
  window.wsEcho = wsEcho;
  window.CommsShim = CommsShim;
  CommsShim.start().catch((e) =>
    console.error('[Comms Shim] localhostServer not reachable — is it running?', e));
}
