/**
 * Comms Shim — client snippet (loader).
 *
 * Paste this whole file into a page's developer console (or load it
 * with <script src="snippet.js">). It loads MQTT.js, connects to
 * localhostServer's MQTT broker, asks it for the Relay Tool, and
 * the tool window appears on the page. Nothing else to do.
 *
 * All traffic is MQTT carrying JSON-RPC 2.0 payloads (see the
 * mqttx package for the topic conventions):
 *   requests   -> shim/rpc/<target>/<clientId>
 *   responses  <- shim/clients/<clientId>/rpc
 *   chat       -> chat/<username>   (chat.message notifications)
 *   scripts    -> scripts/<username> (script.deliver notifications)
 *
 * What it exposes on window:
 *   CommsShim  — { rpc, loadScript, loadRelayTool, connect,
 *                  brokerUrl, assetBase, clientId, toolVersion }
 *   MqttRpc    — the JSON-RPC-over-MQTT client class (used by the tool)
 *   wsEcho     — convenience: await wsEcho('hello') -> "hello"
 *
 * The loader (CommsShim.loadScript) is infrastructure: it is not
 * one of the Relay Tool's listed functions.
 *
 * MQTT.js is loaded from a CDN, falling back to the copy
 * localhostServer serves at /mqtt.min.js. Pending-call lookup is
 * O(1); JSON-RPC ids increment monotonically.
 */
class MqttRpc {
  constructor(brokerUrl, clientId) {
    this.brokerUrl = brokerUrl;
    this.clientId = clientId;
    this.client = null; // MQTT.js client
    this.connected = false;
    this.chatUser = null;
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve, reject}
    this._notifyHandlers = new Map(); // method -> Set<handler>
    this._stateHandlers = new Set(); // (state) => {}
  }

  /** Connect to the broker; resolves on the first connect. */
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.client = window.mqtt.connect(this.brokerUrl, {
        clientId: this.clientId,
        reconnectPeriod: 2000,
      });
      this.client.on('connect', () => {
        this.connected = true;
        this._emitState('connected');
        this.client.subscribe(`shim/clients/${this.clientId}/rpc`, (err) => {
          if (err && !settled) { settled = true; reject(err); }
          else if (!settled) { settled = true; resolve(this); }
        });
      });
      this.client.on('reconnect', () => this._emitState('connecting'));
      this.client.on('close', () => {
        this.connected = false;
        this._emitState('disconnected');
      });
      this.client.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
      });
      this.client.on('message', (topic, payload) =>
        this._onMessage(topic, payload.toString()));
    });
  }

  _emitState(state) {
    this._stateHandlers.forEach((h) => {
      try { h(state); } catch { /* keep going */ }
    });
  }

  /** Subscribe to connection-state changes; returns unsubscribe. */
  onStateChange(handler) {
    this._stateHandlers.add(handler);
    return () => this._stateHandlers.delete(handler);
  }

  _onMessage(topic, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const msgs = Array.isArray(msg) ? msg : [msg];
    for (const res of msgs) {
      if (res.method) {
        // A notification (method, no id): fan out to subscribers.
        const handlers = this._notifyHandlers.get(res.method);
        if (handlers) {
          handlers.forEach((h) => {
            try { h(res.params, topic); } catch { /* keep going */ }
          });
        }
        continue;
      }
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

  /**
   * Send a JSON-RPC 2.0 request to a server target ('localhost',
   * 'remote') and await its result.
   */
  call(method, params, target = 'localhost') {
    if (!this.client || !this.connected) {
      return Promise.reject(new Error('Not connected — call connect() first'));
    }
    const id = this._nextId++;
    const payload = { jsonrpc: '2.0', method, params, id };
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.client.publish(`shim/rpc/${target}/${this.clientId}`,
        JSON.stringify(payload));
    });
  }

  /** Fire-and-forget JSON-RPC notification to a server target. */
  notify(method, params, target = 'localhost') {
    this.client?.publish(`shim/rpc/${target}/${this.clientId}`,
      JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /**
   * Subscribe to notifications (messages with a method and no id),
   * e.g. "chat.message". Handler receives (params, topic).
   * Returns an unsubscribe function.
   */
  onNotification(method, handler) {
    let set = this._notifyHandlers.get(method);
    if (!set) {
      set = new Set();
      this._notifyHandlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Subscribe to an arbitrary topic on this connection. */
  subscribeTopic(topic) {
    this.client?.subscribe(topic);
  }

  /** Unsubscribe from an arbitrary topic. */
  unsubscribeTopic(topic) {
    this.client?.unsubscribe(topic);
  }

  /** Publish a raw payload (object or string) to an arbitrary topic. */
  publishTopic(topic, payload) {
    this.client?.publish(topic,
      typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  /** Subscribe to my chat topic: chat/<name>. */
  setChatUser(name) {
    if (this.chatUser === name) return;
    if (this.chatUser) this.client.unsubscribe(`chat/${this.chatUser}`);
    this.chatUser = name;
    if (name) this.client.subscribe(`chat/${name}`);
  }

  /** Send a chat message to user `to` (a chat.message notification). */
  sendChat(to, text) {
    const payload = {
      jsonrpc: '2.0',
      method: 'chat.message',
      params: { from: this.chatUser || this.clientId, text },
    };
    this.client.publish(`chat/${to}`, JSON.stringify(payload));
  }

  close() {
    this.client?.end(true);
    this.client = null;
    this.connected = false;
  }
}

/**
 * CommsShim — the loader. Owns the shared connection to
 * localhostServer's broker and loads JavaScript from
 * localhostServer (the Relay Tool today; anything else the server
 * offers later).
 */
const CommsShim = {
  // Stamped by the GUI with live values at serve time (the
  // placeholders are replaced, like the Relay Tool version). The
  // fallbacks below are the default ports, for using the raw file.
  brokerUrl: '__BROKER_URL__',
  assetBase: '__ASSET_BASE__',
  rpc: null,         // shared MqttRpc, set by connect()
  clientId: `web-${Math.random().toString(16).slice(2, 10)}`,
  toolVersion: null, // set by the Relay Tool when it loads
  // The Relay Tool version this snippet was served with — the GUI
  // stamps it in at serve time (the placeholder below is replaced,
  // like the addresses). The tool registers its components under
  // tag names suffixed with its version, so versions can coexist
  // on a page; this tells the snippet which one it asked for.
  expectedToolVersion: '__RELAY_TOOL_VERSION__',

  /** Load and evaluate a JavaScript file from url. */
  loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${url}`));
      document.head.appendChild(script);
    });
  },

  /** Load MQTT.js: CDN first, localhostServer's vendored copy as fallback. */
  async loadMqtt() {
    if (window.mqtt) return;
    try {
      await this.loadScript(
        'https://cdn.jsdelivr.net/npm/mqtt@5.16.1/dist/mqtt.min.js');
    } catch {
      await this.loadScript(`${this.assetBase}/mqtt.min.js`);
    }
    if (!window.mqtt) throw new Error('MQTT.js failed to load');
  },

  /** Connect the shared MQTT client (once) and return it. */
  async connect() {
    if (!this.rpc) {
      this.rpc = new MqttRpc(this.brokerUrl, this.clientId);
      await this.rpc.connect();
    }
    return this.rpc;
  },

  /** Ask localhostServer for the Relay Tool and show it. */
  async loadRelayTool() {
    const expected = this.expectedToolVersion;
    if (window.CommsShimTools?.[expected]) return; // our version is up
    await this.loadScript(`${this.assetBase}/relay-tool.js`);
    if (!window.CommsShimTools?.[expected] && !this.toolVersion) {
      throw new Error('Relay Tool loaded but did not start (see console)');
    }
    if (this.toolVersion && /^\d+\.\d+\.\d+$/.test(expected)
        && this.toolVersion !== expected) {
      console.warn(`[Comms Shim] snippet expected Relay Tool v${expected}, `
        + `server served v${this.toolVersion} — using the served version`);
    }
  },

  /** Load MQTT.js, connect, then load the Relay Tool. Runs automatically. */
  async start() {
    // Resolve serve-time placeholders that were never stamped
    // (raw file use) to the default addresses.
    if (this.brokerUrl.includes('__')) this.brokerUrl = 'ws://127.0.0.1:8083';
    if (this.assetBase.includes('__')) this.assetBase = 'http://127.0.0.1:8765';
    await this.loadMqtt();
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
  window.MqttRpc = MqttRpc;
  window.wsEcho = wsEcho;
  window.CommsShim = CommsShim;
  CommsShim.start().catch((e) =>
    console.error('[Comms Shim] localhostServer not reachable — is it running?', e));
}
