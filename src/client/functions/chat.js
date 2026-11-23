/**
 * Comms Shim — Relay Tool function: Chat (v1.0.0)
 *
 * A loadable function: localhostServer serves this file at
 * /functions/chat.js and lists it in the functions.list catalog.
 * The Relay Tool core loads it on demand; it defines its panel
 * component and registers with the core via
 * window.RelayTool.registerFunction. Functions version
 * independently of the tool — the tag name carries this version.
 *
 * Chat: MQTT chat between users, JSON-RPC 2.0 payloads
 * (chat.message notifications on chat/<username> topics). The
 * panel owns its own MqttRpc connection to the broker in the
 * Broker field — localhostServer's broker by default, but any
 * broker works (e.g. the Remote Server directly: WebSocket
 * connections are not same-origin bound). Layout: a broker row
 * (URL input, connect button with link icon, status light — red
 * disconnected, yellow connecting, green connected, all CSS off
 * data-state), a "you are / chat with" row, an IRC-style message
 * log, and a composer.
 */
(() => {
  const VERSION = '1.0.0';
  const TAG = `relay-chat-panel-v${VERSION.replaceAll('.', '-')}`;

class RelayChatPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._rpc = null;
    this._unsubscribe = [];
    this._state = 'disconnected';
  }

  connectedCallback() {
    const homeBroker = window.CommsShim?.brokerUrl || 'ws://127.0.0.1:8083';
    this.shadowRoot.innerHTML = `
      <style>
        ${window.RelayTool.panelCSS}
        .chat { display: flex; flex-direction: column; height: 100%;
                box-sizing: border-box; gap: 0.5rem; }
        .top, .who { display: flex; align-items: center; gap: 0.4rem; }
        .top input, .who input { flex: 1; min-width: 0; padding: 0.4rem;
                font: inherit; }
        .top input { font-family: ui-monospace, Menlo, monospace;
                     font-size: 0.85rem; }
        .who label { color: var(--rt-muted, #777); font-size: 0.85rem; }
        .who input { flex: 0 1 8rem; }
        .connect { display: inline-flex; align-items: center; gap: 0.35rem;
                   padding: 0.4rem 0.6rem; font: inherit; cursor: pointer; }
        .connect svg { width: 14px; height: 14px; flex: none; }
        .connect .label-disconnect { display: none; }
        .chat[data-state="connected"] .connect .label-connect { display: none; }
        .chat[data-state="connected"] .connect .label-disconnect { display: inline; }
        .light { width: 11px; height: 11px; border-radius: 50%; flex: none;
                 background: #d64545;
                 box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15) inset; }
        .chat[data-state="connecting"] .light { background: #e3a008;
                 animation: pulse 900ms ease-in-out infinite; }
        .chat[data-state="connected"] .light { background: #2da44e; }
        @keyframes pulse { 50% { opacity: 0.35; } }
        .log { flex: 1; overflow-y: auto; min-height: 0;
               border: 1px solid var(--rt-border, #ddd); border-radius: 6px;
               padding: 0.5rem;
               font-family: ui-monospace, Menlo, monospace;
               font-size: 0.82rem; }
        .line { margin-bottom: 0.25rem; overflow-wrap: anywhere; }
        .line .from { font-weight: 700; }
        .line.sys { color: var(--rt-muted, #777); font-style: italic; }
        .line.err { color: #b3261e; }
        .composer { display: flex; gap: 0.4rem; }
        .composer input { flex: 1; min-width: 0; padding: 0.4rem; font: inherit; }
        .composer button { padding: 0.4rem 0.9rem; font: inherit;
                           cursor: pointer; }
      </style>
      <div class="chat panel" data-state="disconnected">
        <form class="top">
          <input name="broker" value="${homeBroker}"
                 placeholder="broker — ws://host:port"
                 autocomplete="off" spellcheck="false">
          <button class="connect" type="submit" title="Connect / disconnect">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
                 stroke-width="1.6" aria-hidden="true">
              <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 1 0-4.2-4.2l-1 1"/>
              <path d="M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 1 0 4.2 4.2l1-1"/>
            </svg>
            <span class="label-connect">Connect</span>
            <span class="label-disconnect">Disconnect</span>
          </button>
          <span class="light" role="status" aria-label="Not connected"></span>
        </form>
        <div class="who">
          <label for="me">You are</label>
          <input name="me" value="steve" autocomplete="off" spellcheck="false">
          <label for="peer">Chat with</label>
          <input name="peer" value="remote" autocomplete="off" spellcheck="false">
        </div>
        <div class="log" aria-live="polite"></div>
        <form class="composer">
          <input name="text" placeholder="Message…" autocomplete="off">
          <button type="submit">Send</button>
        </form>
      </div>`;

    this._root = this.shadowRoot.querySelector('.chat');
    this._logEl = this.shadowRoot.querySelector('.log');
    this._broker = this.shadowRoot.querySelector('input[name="broker"]');
    this._me = this.shadowRoot.querySelector('input[name="me"]');
    this._peer = this.shadowRoot.querySelector('input[name="peer"]');
    this._text = this.shadowRoot.querySelector('input[name="text"]');
    this._light = this.shadowRoot.querySelector('.light');

    this.shadowRoot.querySelector('.top').addEventListener('submit', (e) => {
      e.preventDefault();
      this._toggleConnect();
    });
    this.shadowRoot.querySelector('.composer')
      .addEventListener('submit', (e) => {
        e.preventDefault();
        this._send();
      });
    this._me.addEventListener('change', () => {
      if (this._rpc && this._state === 'connected') {
        this._rpc.setChatUser(this._me.value.trim());
        this._appendLine('sys', '',
          `Now subscribed as ${this._me.value.trim()} (chat/${this._me.value.trim()})`);
      }
    });
    this._broker.focus();
  }

  disconnectedCallback() {
    this._teardown();
  }

  _teardown() {
    this._unsubscribe.forEach((u) => u());
    this._unsubscribe = [];
    if (this._rpc) {
      this._rpc.close();
      this._rpc = null;
    }
  }

  _setState(state) {
    this._state = state;
    this._root.dataset.state = state;
    this._broker.disabled = state !== 'disconnected';
    this._light.setAttribute('aria-label', {
      disconnected: 'Not connected',
      connecting: 'Connecting…',
      connected: 'Connected',
    }[state]);
  }

  async _toggleConnect() {
    if (this._state === 'connected' || this._state === 'connecting') {
      this._teardown();
      this._setState('disconnected');
      this._appendLine('sys', '', 'Disconnected');
      return;
    }
    const url = this._broker.value.trim();
    const me = this._me.value.trim();
    if (!url || !me) {
      this._appendLine('err', '', 'Broker URL and your name are required');
      return;
    }
    if (!window.mqtt || !window.MqttRpc) {
      this._appendLine('err', '', 'MQTT client not loaded — is localhostServer reachable?');
      return;
    }
    this._setState('connecting');
    const rpc = new window.MqttRpc(url, `${window.CommsShim?.clientId || 'web'}-chat`);
    this._rpc = rpc;
    this._unsubscribe.push(rpc.onStateChange((state) => {
      if (this._rpc !== rpc) return;
      if (state === 'connected') this._setState('connected');
      else if (state === 'disconnected' && this._state === 'connected') {
        this._setState('disconnected');
        this._appendLine('sys', '', 'Broker connection lost');
      }
    }));
    this._unsubscribe.push(rpc.onNotification('chat.message', (p) => {
      this._appendLine('', p?.from || 'peer', p?.text ?? '');
    }));
    try {
      await rpc.connect();
      rpc.setChatUser(me);
      this._setState('connected');
      this._appendLine('sys', '',
        `Connected to ${url} — subscribed to chat/${me}`);
      this._text.focus();
    } catch (err) {
      this._teardown();
      this._setState('disconnected');
      this._appendLine('err', '', err.message || String(err));
    }
  }

  _send() {
    const text = this._text.value;
    if (!text) return;
    if (this._state !== 'connected' || !this._rpc) {
      this._appendLine('err', '', 'Not connected — connect to a broker first');
      return;
    }
    const peer = this._peer.value.trim();
    if (!peer) {
      this._appendLine('err', '', 'Who are you chatting with? Set "Chat with"');
      return;
    }
    this._rpc.sendChat(peer, text);
    this._appendLine('me', 'me', text);
    this._text.value = '';
  }

  _appendLine(kind, from, text) {
    const line = document.createElement('div');
    line.className = `line ${kind}`.trim();
    if (kind === 'sys' || kind === 'err') {
      line.textContent = text;
    } else {
      const who = document.createElement('span');
      who.className = 'from';
      who.textContent = `${from}: `;
      line.append(who, document.createTextNode(String(text)));
    }
    this._logEl.appendChild(line);
    this._logEl.scrollTop = this._logEl.scrollHeight;
  }
}

  window.RelayTool?.registerFunction({
    id: 'chat',
    version: VERSION,
    define() {
      if (!customElements.get(TAG)) {
        customElements.define(TAG, RelayChatPanel);
      }
      return TAG;
    },
  });
})();
