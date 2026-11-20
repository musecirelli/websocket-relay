/**
 * Comms Shim — Relay Tool v0.3.0
 *
 * Served by localhostServer (GET /relay-tool.js) and loaded by the
 * client snippet. A floating tool window built from standard web
 * components — vanilla JS/HTML/CSS, no frameworks.
 *
 * Components (tag names carry the version — see below):
 *   <relay-tool-v0-3-0>           the floating window (drag, resize, close)
 *   <relay-function-list-v0-3-0>  left panel: the available functions
 *   <relay-echo-panel-v0-3-0>     the echo function panel (right side)
 *   <relay-chat-panel-v0-3-0>     the chat function panel (Remote Server relay)
 *
 * Versioned tags: a custom element name can only ever be defined
 * once per page, so the tag names are suffixed with the tool
 * version (relay-tool-v0-3-0). Different versions of the tool can
 * be dropped onto the same page without colliding; every tag
 * lookup in this file is computed from VERSION via tag(). There
 * is deliberately no catch-and-retry on define() — if you need a
 * clean slate, refresh the page.
 *
 * Communication follows the project UI rules: components talk via
 * custom elements, data- attributes, and CustomEvents; animations
 * are CSS, not JS. The function list is driven by the FUNCTIONS
 * registry below — adding a function means one registry entry plus
 * one panel component (the same Registry pattern as the server's
 * JSON-RPC Dispatcher). The snippet's JS loader is infrastructure
 * and is deliberately NOT a registry entry.
 */
(() => {
  const VERSION = '0.3.0';

  // This exact version already loaded? Then there is nothing to
  // do — the same code is already registered under the same tags.
  // (A *different* version is fine: it registers its own tags.)
  window.CommsShimTools ??= {};
  if (window.CommsShimTools[VERSION]) return;

  // Version-suffixed tag names: tag('relay-tool') -> 'relay-tool-v0-2-0'.
  const tagSuffix = `-v${VERSION.replaceAll('.', '-')}`;
  const tag = (base) => base + tagSuffix;

  const FUNCTIONS = [
    { id: 'echo', label: 'Echo', tag: 'relay-echo-panel' }, // base tag; tag() adds the version
    { id: 'chat', label: 'Chat', tag: 'relay-chat-panel' },
  ];

  const panelCSS = `
    :host { display: block; height: 100%; }
    .panel { height: 100%; box-sizing: border-box; padding: 0.6rem;
             animation: panel-in 160ms ease-out; }
    @keyframes panel-in {
      from { opacity: 0; transform: translateX(6px); }
      to   { opacity: 1; transform: none; }
    }
  `;

  // ----------------------------------------------------------------
  // <relay-function-list-vX-Y-Z> — left panel listing the functions.
  // Clicking an item marks it active (aria-selected + CSS) and fires
  // a relay-function-select CustomEvent; <relay-tool> listens and
  // swaps the right-hand panel.
  // ----------------------------------------------------------------
  class RelayFunctionList extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; height: 100%; }
          nav { height: 100%; box-sizing: border-box; padding: 0.4rem;
                background: var(--rt-list-bg, #f4f4f6);
                border-right: 1px solid var(--rt-border, #ddd); }
          button { display: block; width: 100%; text-align: left;
                   padding: 0.45rem 0.6rem; margin-bottom: 0.25rem;
                   border: 1px solid transparent; border-radius: 6px;
                   background: none; font: inherit; cursor: pointer;
                   color: var(--rt-text, #222);
                   transition: background 120ms ease; }
          button:hover { background: var(--rt-hover, #e8e8ee); }
          button[aria-selected="true"] {
            background: var(--rt-accent, #2f6fed); color: #fff; }
        </style>
        <nav part="list">
          ${FUNCTIONS.map((f) => `
            <button type="button" role="option" data-function-id="${f.id}"
                    aria-selected="false">${f.label}</button>`).join('')}
        </nav>`;
      this.shadowRoot.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-function-id]');
        if (btn) this.select(btn.dataset.functionId, true);
      });
    }

    /** Mark id active; optionally tell the tool to show its panel. */
    select(id, notify = false) {
      for (const btn of this.shadowRoot.querySelectorAll('button')) {
        btn.setAttribute('aria-selected',
          String(btn.dataset.functionId === id));
      }
      if (notify) {
        this.dispatchEvent(new CustomEvent('relay-function-select', {
          detail: { id }, bubbles: true, composed: true,
        }));
      }
    }
  }

  // ----------------------------------------------------------------
  // <relay-echo-panel-vX-Y-Z> — the echo function: a text field, a Send
  // button, and a readonly log; every echo is appended to the log.
  // Talks to localhostServer through the snippet's shared WsRpc
  // (window.CommsShim.rpc).
  // ----------------------------------------------------------------
  class RelayEchoPanel extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
      this.shadowRoot.innerHTML = `
        <style>
          ${panelCSS}
          form { display: flex; gap: 0.4rem; margin-bottom: 0.5rem; }
          input { flex: 1; padding: 0.4rem; font: inherit; }
          button { padding: 0.4rem 0.9rem; font: inherit; cursor: pointer; }
          textarea { width: 100%; height: calc(100% - 3rem);
                     box-sizing: border-box; resize: none;
                     font-family: ui-monospace, Menlo, monospace;
                     font-size: 0.82rem; padding: 0.5rem; }
        </style>
        <div class="panel">
          <form>
            <input name="message" placeholder="message to echo"
                   autocomplete="off">
            <button type="submit">Send</button>
          </form>
          <textarea readonly placeholder="Echoes will appear here"></textarea>
        </div>`;
      const form = this.shadowRoot.querySelector('form');
      const input = this.shadowRoot.querySelector('input');
      this._log = this.shadowRoot.querySelector('textarea');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const message = input.value;
        if (!message) return;
        this._append(`> ${message}`);
        try {
          const rpc = window.CommsShim?.rpc;
          if (!rpc) throw new Error('not connected to localhostServer');
          const result = await rpc.call('echo', message);
          this._append(`< ${typeof result === 'string' ? result : JSON.stringify(result)}`);
        } catch (err) {
          this._append(`! ${err.message || err}`);
        }
        input.select();
      });
      input.focus();
    }

    _append(line) {
      this._log.value += line + '\n';
      this._log.scrollTop = this._log.scrollHeight;
    }
  }

  // ----------------------------------------------------------------
  // <relay-chat-panel-vX-Y-Z> — the Chat function: relay messages
  // through localhostServer to a Remote Server.
  //
  // Layout (top to bottom): an address row (URL/IP + port input, a
  // connect button with a link icon, and a status light — red
  // disconnected, yellow connecting, green connected; all CSS off
  // the container's data-state), an IRC-style message log, and a
  // composer (text input + Send button).
  //
  // Talks JSON-RPC to localhostServer: relay.connect /
  // relay.disconnect / relay.send / relay.status, and subscribes
  // to the relay.message / relay.status notifications the server
  // pushes when the Remote Server says something or goes away.
  // The relay belongs to the WebSocket session, not to this panel:
  // switching functions keeps the connection, and a fresh panel
  // syncs its state via relay.status.
  // ----------------------------------------------------------------
  class RelayChatPanel extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._unsubscribe = [];
      this._state = 'disconnected';
    }

    connectedCallback() {
      this.shadowRoot.innerHTML = `
        <style>
          ${panelCSS}
          .chat { display: flex; flex-direction: column; height: 100%;
                  box-sizing: border-box; gap: 0.5rem; }
          .top { display: flex; align-items: center; gap: 0.4rem; }
          .top input { flex: 1; min-width: 0; padding: 0.4rem; font: inherit;
                       font-family: ui-monospace, Menlo, monospace;
                       font-size: 0.85rem; }
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
            <input name="address"
                   placeholder="host:port — e.g. 192.168.1.20:9000"
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
          <div class="log" aria-live="polite"></div>
          <form class="composer">
            <input name="text" placeholder="Message…" autocomplete="off">
            <button type="submit">Send</button>
          </form>
        </div>`;

      this._root = this.shadowRoot.querySelector('.chat');
      this._logEl = this.shadowRoot.querySelector('.log');
      this._addr = this.shadowRoot.querySelector('input[name="address"]');
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

      const rpc = window.CommsShim?.rpc;
      if (rpc?.onNotification) {
        this._unsubscribe.push(rpc.onNotification('relay.message', (p) => {
          this._appendLine('', p?.from || 'remote', p?.text ?? '');
        }));
        this._unsubscribe.push(rpc.onNotification('relay.status', (p) => {
          if (p?.state === 'disconnected' && this._state === 'connected') {
            this._setState('disconnected');
            this._appendLine('sys', '', 'Remote Server disconnected');
          }
        }));
        // Sync with the session's real relay state.
        rpc.call('relay.status').then((s) => {
          if (s?.state === 'connected') {
            this._setState('connected');
            this._appendLine('sys', '', `Connected to ${s.remote}`);
          }
        }).catch(() => {});
      } else {
        this._appendLine('err', '', 'Not connected to localhostServer');
      }
      this._addr.focus();
    }

    disconnectedCallback() {
      this._unsubscribe.forEach((u) => u());
      this._unsubscribe = [];
    }

    _setState(state) {
      this._state = state;
      this._root.dataset.state = state;
      this._addr.disabled = state !== 'disconnected';
      this._light.setAttribute('aria-label', {
        disconnected: 'Not connected',
        connecting: 'Connecting…',
        connected: 'Connected',
      }[state]);
    }

    /** "https://example.com:9000/x" / "192.168.1.20" -> {host, port}. */
    _parseAddress(raw) {
      const s = String(raw || '').trim()
        .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '') // strip scheme
        .split('/')[0];
      const i = s.lastIndexOf(':');
      if (i > 0) {
        const port = Number.parseInt(s.slice(i + 1), 10);
        return { host: s.slice(0, i), port: Number.isNaN(port) ? 9000 : port };
      }
      return { host: s, port: 9000 };
    }

    async _toggleConnect() {
      const rpc = window.CommsShim?.rpc;
      if (!rpc) {
        this._appendLine('err', '', 'Not connected to localhostServer');
        return;
      }
      if (this._state === 'connected') {
        try { await rpc.call('relay.disconnect'); } catch { /* already gone */ }
        this._setState('disconnected');
        this._appendLine('sys', '', 'Disconnected');
        return;
      }
      if (this._state === 'connecting') return;
      const { host, port } = this._parseAddress(this._addr.value);
      if (!host) {
        this._appendLine('err', '', 'Enter a host (URL or IP) to connect to');
        return;
      }
      this._setState('connecting');
      try {
        const result = await rpc.call('relay.connect', { host, port });
        this._setState('connected');
        this._appendLine('sys', '',
          `Connected to ${result?.remote ?? `${host}:${port}`}`);
        this._text.focus();
      } catch (err) {
        this._setState('disconnected');
        this._appendLine('err', '', err.message || String(err));
      }
    }

    async _send() {
      const text = this._text.value;
      if (!text) return;
      if (this._state !== 'connected') {
        this._appendLine('err', '',
          'Not connected — connect to a Remote Server first');
        return;
      }
      try {
        await window.CommsShim.rpc.call('relay.send', { text });
        this._appendLine('me', 'me', text);
        this._text.value = '';
      } catch (err) {
        this._appendLine('err', '', err.message || String(err));
      }
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

  // ----------------------------------------------------------------
  // <relay-tool-vX-Y-Z> — the floating window. Drag by the header
  // (pointer events), resize by the corner (pure CSS resize),
  // close with the × button. Hosts the function list on the left
  // and the active function's panel on the right; the active
  // function is mirrored to the data-active-function attribute.
  // ----------------------------------------------------------------
  class RelayTool extends HTMLElement {
    constructor() {
      super();
      // A custom element constructor must not add attributes or
      // children to the element — createElement throws
      // NotSupportedError ("The result must not have attributes").
      // attachShadow is allowed; everything else goes in
      // connectedCallback.
      this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
      this.dataset.version = VERSION;
      this.shadowRoot.innerHTML = `
        <style>
          :host { position: fixed; top: 16px; right: 16px; z-index: 2147483000;
                  font-family: system-ui, sans-serif; font-size: 14px;
                  color: var(--rt-text, #222); }
          .window { width: 560px; height: 380px; min-width: 340px;
                    min-height: 220px; resize: both; overflow: hidden;
                    display: flex; flex-direction: column;
                    background: var(--rt-bg, #fff);
                    border: 1px solid var(--rt-border, #ccc);
                    border-radius: 10px;
                    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
                    animation: tool-in 180ms ease-out; }
          @keyframes tool-in {
            from { opacity: 0; transform: translateY(-6px) scale(0.98); }
            to   { opacity: 1; transform: none; }
          }
          header { display: flex; align-items: center; gap: 0.5rem;
                   padding: 0.45rem 0.7rem; cursor: move; user-select: none;
                   background: var(--rt-header-bg, #ececf1);
                   border-bottom: 1px solid var(--rt-border, #ddd); }
          header .title { font-weight: 600; flex: 1; }
          header .version { color: var(--rt-muted, #777);
                            font-size: 0.8rem; }
          header button { border: none; background: none; font: inherit;
                          cursor: pointer; padding: 0 0.3rem; }
          main { flex: 1; display: flex; min-height: 0; }
          ${tag('relay-function-list')} { width: 150px; flex: none; }
          .host { flex: 1; min-width: 0; }
        </style>
        <div class="window">
          <header part="header">
            <span class="title">Comms Shim — Relay Tool</span>
            <span class="version">v${VERSION}</span>
            <button type="button" data-action="close"
                    aria-label="Close">✕</button>
          </header>
          <main>
            <${tag('relay-function-list')}></${tag('relay-function-list')}>
            <div class="host" part="panel-host"></div>
          </main>
        </div>`;

      this._list = this.shadowRoot.querySelector(tag('relay-function-list'));
      this._host = this.shadowRoot.querySelector('.host');
      this._window = this.shadowRoot.querySelector('.window');

      this.addEventListener('relay-function-select', (e) =>
        this.showFunction(e.detail.id));
      this.shadowRoot.querySelector('[data-action="close"]')
        .addEventListener('click', () => this.remove());
      this._dragSetup(this.shadowRoot.querySelector('header'));

      // Open on the first registered function.
      if (FUNCTIONS.length) this.showFunction(FUNCTIONS[0].id);
    }

    /** Show the panel component registered for id (O(1) lookup). */
    showFunction(id) {
      const fn = FUNCTIONS.find((f) => f.id === id);
      if (!fn) return;
      this.dataset.activeFunction = id;
      this._list.select(id);
      this._host.replaceChildren(document.createElement(tag(fn.tag)));
    }

    _dragSetup(handle) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        const rect = this.getBoundingClientRect();
        // Switch from right-anchored to explicit left/top once.
        this.style.left = `${rect.left}px`;
        this.style.top = `${rect.top}px`;
        this.style.right = 'auto';
        const dx = e.clientX - rect.left;
        const dy = e.clientY - rect.top;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          this.style.left = `${ev.clientX - dx}px`;
          this.style.top = `${ev.clientY - dy}px`;
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
    }
  }

  // Plain defines: the versioned names cannot collide with a
  // different version, and the same version returned early above.
  customElements.define(tag('relay-function-list'), RelayFunctionList);
  customElements.define(tag('relay-echo-panel'), RelayEchoPanel);
  customElements.define(tag('relay-chat-panel'), RelayChatPanel);
  customElements.define(tag('relay-tool'), RelayTool);

  try {
    const host = document.body ?? document.documentElement;
    host.appendChild(document.createElement(tag('relay-tool')));
    window.CommsShimTools[VERSION] = { tagSuffix };
    if (window.CommsShim) window.CommsShim.toolVersion = VERSION;
    window.dispatchEvent(new CustomEvent('comms-shim:tool-ready', {
      detail: { version: VERSION },
    }));
  } catch (e) {
    console.error('[Comms Shim] Relay Tool failed to start:', e);
  }
})();
