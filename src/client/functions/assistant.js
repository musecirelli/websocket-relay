/**
 * Comms Shim — Relay Tool function: Assistant (v1.0.0)
 *
 * A loadable function: localhostServer serves this file at
 * /functions/assistant.js and lists it in the functions.list
 * catalog. The Relay Tool core loads it on demand; it defines
 * its panel component and registers with the core via
 * window.RelayTool.registerFunction. Functions version
 * independently of the tool — the tag name carries this version.
 *
 * Assistant: a page-debugging companion. While the panel is
 * connected it hooks the page's console (log/info/warn/error,
 * window.onerror, unhandled promise rejections) into a local,
 * deduplicated buffer — repeats collapse by fingerprint (level
 * + text + source) into one entry with a count and first/last
 * timestamps, so a broken page spamming the same error cannot
 * flood the buffer. Nothing leaves the page until a snapshot is
 * requested: Muse sends an assistant.snapshot notification to
 * assistant/<username>/request, and the panel answers on
 * assistant/<username>/snapshot with the page's URL and title,
 * screen/viewport metrics, the full DOM (chunked), and the
 * console buffer. A panel toggle instead streams each new
 * distinct entry live on assistant/<username>/console. The
 * request channel takes snapshot requests only — no eval, no
 * arbitrary commands. A badge on the page shows the assistant
 * is live; clicking it disconnects.
 */
(() => {
  const VERSION = '1.0.0';
  const TAG = `relay-assistant-panel-v${VERSION.replaceAll('.', '-')}`;
  const MAX_ENTRIES = 200;   // distinct (deduplicated) entries kept
  const MAX_TEXT = 500;      // chars kept per entry
  const DOM_CHUNK = 16384;   // chars per snapshot DOM chunk
  const RECENT_SHOWN = 8;    // entries previewed in the panel

  function serializeArg(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) {
      const frame = a.stack ? a.stack.split('\n')[1]?.trim() : '';
      return `${a.name}: ${a.message}${frame ? ' @ ' + frame : ''}`;
    }
    try {
      const s = JSON.stringify(a);
      return s === undefined ? String(a) : s;
    } catch {
      return String(a);
    }
  }

  class RelayAssistantPanel extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._rpc = null;
      this._unsubscribe = [];
      this._state = 'disconnected';
      this._entries = new Map(); // fingerprint -> entry, insertion-ordered
      this._total = 0;
      this._dropped = 0;
      this._hooks = null;
      this._badge = null;
      this._renderTimer = null;
    }

    connectedCallback() {
      const homeBroker = window.CommsShim?.brokerUrl || 'ws://127.0.0.1:8083';
      this.shadowRoot.innerHTML = `
        <style>
          ${window.RelayTool.panelCSS}
          .assistant { display: flex; flex-direction: column; height: 100%;
                       box-sizing: border-box; gap: 0.5rem; }
          .top, .bar { display: flex; align-items: center; gap: 0.4rem; }
          .top input { flex: 1; min-width: 0; padding: 0.4rem; font: inherit;
                       font-family: ui-monospace, Menlo, monospace;
                       font-size: 0.85rem; }
          .top label, .bar label { color: var(--rt-muted, #777);
                                   font-size: 0.85rem; }
          .top input[name="me"] { flex: 0 1 7rem;
                                  font-family: inherit; font-size: inherit; }
          .connect, .snap { padding: 0.4rem 0.6rem; font: inherit;
                            cursor: pointer; }
          .snap:disabled { cursor: default; opacity: 0.5; }
          .light { width: 11px; height: 11px; border-radius: 50%; flex: none;
                   background: #d64545;
                   box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15) inset; }
          .assistant[data-state="connecting"] .light { background: #e3a008;
                   animation: pulse 900ms ease-in-out infinite; }
          .assistant[data-state="connected"] .light { background: #2da44e; }
          @keyframes pulse { 50% { opacity: 0.35; } }
          .bar .summary { color: var(--rt-muted, #777); font-size: 0.85rem;
                          margin-left: auto; }
          .log { flex: 1; overflow: auto; min-height: 0;
                 font-family: ui-monospace, Menlo, monospace;
                 font-size: 0.78rem; line-height: 1.5; }
          .log .row { white-space: nowrap; overflow: hidden;
                      text-overflow: ellipsis; }
          .log .count { color: var(--rt-muted, #777); }
          .log .lvl-error { color: #d64545; }
          .log .lvl-warn { color: #e3a008; }
        </style>
        <div class="assistant panel" data-state="disconnected">
          <form class="top">
            <label for="broker">Broker</label>
            <input name="broker" value="${homeBroker}"
                   placeholder="broker — ws://host:port"
                   autocomplete="off" spellcheck="false">
            <label for="me">You are</label>
            <input name="me" value="steve" autocomplete="off" spellcheck="false">
            <button class="connect" type="submit">Connect</button>
            <span class="light" role="status" aria-label="Not connected"></span>
          </form>
          <div class="bar">
            <button class="snap" type="button" disabled>Send snapshot</button>
            <label><input type="checkbox" name="stream"> Stream console</label>
            <span class="summary">0 distinct · 0 total</span>
          </div>
          <div class="log" part="log"></div>
        </div>`;

      this._root = this.shadowRoot.querySelector('.assistant');
      this._broker = this.shadowRoot.querySelector('input[name="broker"]');
      this._me = this.shadowRoot.querySelector('input[name="me"]');
      this._light = this.shadowRoot.querySelector('.light');
      this._snapBtn = this.shadowRoot.querySelector('.snap');
      this._streamBox = this.shadowRoot.querySelector('input[name="stream"]');
      this._summary = this.shadowRoot.querySelector('.summary');
      this._logEl = this.shadowRoot.querySelector('.log');

      this.shadowRoot.querySelector('.top').addEventListener('submit', (e) => {
        e.preventDefault();
        this._toggleConnect();
      });
      this._me.addEventListener('change', () => {
        if (this._rpc && this._state === 'connected') {
          this._rpc.unsubscribeTopic(`assistant/${this._subscribedAs}/request`);
          this._subscribeAs(this._me.value.trim());
        }
      });
      this._snapBtn.addEventListener('click', () => this._sendSnapshot(''));
      this._streamBox.addEventListener('change', () => {
        // Turning streaming on sends the current buffer once, so
        // the other side starts from the same picture.
        if (this._streamBox.checked && this._state === 'connected') {
          for (const e of this._entries.values()) this._publishEntry(e);
        }
      });

      this._installHooks();
      this._renderLog();
      // Starts disconnected, like Chat: the user clicks Connect.
    }

    disconnectedCallback() {
      this._teardown();
      this._removeHooks();
      this._removeBadge();
    }

    _teardown() {
      this._unsubscribe.forEach((u) => u());
      this._unsubscribe = [];
      if (this._rpc) {
        this._rpc.close();
        this._rpc = null;
      }
      this._setState('disconnected');
    }

    _setState(state) {
      this._state = state;
      if (!this._root) return;
      this._root.dataset.state = state;
      this._light?.setAttribute('aria-label',
        state === 'connected' ? 'Connected' : 'Not connected');
      const btn = this.shadowRoot.querySelector('.connect');
      if (btn) btn.textContent =
        state === 'connected' || state === 'connecting' ? 'Disconnect' : 'Connect';
      if (this._snapBtn) this._snapBtn.disabled = state !== 'connected';
    }

    async _toggleConnect() {
      if (this._state === 'connected' || this._state === 'connecting') {
        this._teardown();
        this._removeBadge();
        return;
      }
      const url = this._broker.value.trim();
      const me = this._me.value.trim();
      if (!url || !me) return;
      if (!window.mqtt || !window.MqttRpc) return;
      this._setState('connecting');
      const rpc = new window.MqttRpc(url,
        `${window.CommsShim?.clientId || 'web'}-assistant`);
      this._rpc = rpc;
      this._unsubscribe.push(rpc.onStateChange((s) => {
        if (this._rpc === rpc) this._setState(s);
      }));
      this._unsubscribe.push(rpc.onNotification('assistant.snapshot', (p) => {
        this._sendSnapshot(p?.id || '');
      }));
      try {
        await rpc.connect();
        this._subscribeAs(me);
        this._setState('connected');
        this._showBadge();
      } catch {
        this._teardown();
      }
    }

    _subscribeAs(name) {
      this._subscribedAs = name;
      if (name) this._rpc.subscribeTopic(`assistant/${name}/request`);
    }

    _showBadge() {
      this._removeBadge();
      const badge = document.createElement('div');
      badge.textContent = 'Assistant: live — click to stop';
      badge.style.cssText = 'position:fixed; left:12px; bottom:12px; ' +
        'z-index:2147482998; background:#222; color:#eee; ' +
        'font:12px system-ui, sans-serif; padding:4px 10px; ' +
        'border-radius:999px; opacity:0.85; cursor:pointer;';
      badge.addEventListener('click', () => this._toggleConnect());
      document.body.appendChild(badge);
      this._badge = badge;
    }

    _removeBadge() {
      this._badge?.remove();
      this._badge = null;
    }

    // --- console capture -------------------------------------------

    _installHooks() {
      if (this._hooks) return;
      const orig = {};
      for (const level of ['log', 'info', 'warn', 'error']) {
        orig[level] = console[level];
        console[level] = (...args) => {
          try {
            this._addEntry(level, args.map(serializeArg).join(' '), '');
          } catch { /* capture must never break the page */ }
          orig[level].apply(console, args);
        };
      }
      this._onError = (e) => {
        if (!e.message) return; // resource-load errors carry no message
        const source = e.filename
          ? `${e.filename}:${e.lineno || 0}:${e.colno || 0}` : '';
        this._addEntry('error', e.message, source);
      };
      this._onRejection = (e) => {
        this._addEntry('error',
          'unhandledrejection: ' + serializeArg(e.reason), '');
      };
      window.addEventListener('error', this._onError);
      window.addEventListener('unhandledrejection', this._onRejection);
      this._hooks = orig;
    }

    _removeHooks() {
      if (!this._hooks) return;
      for (const level of ['log', 'info', 'warn', 'error']) {
        console[level] = this._hooks[level];
      }
      window.removeEventListener('error', this._onError);
      window.removeEventListener('unhandledrejection', this._onRejection);
      this._hooks = null;
    }

    _addEntry(level, text, source) {
      text = String(text).slice(0, MAX_TEXT);
      this._total++;
      const key = `${level}|${source}|${text}`;
      const now = Date.now();
      let entry = this._entries.get(key);
      if (entry) {
        entry.count++;
        entry.last = now;
      } else {
        entry = { level, text, source, count: 1, first: now, last: now };
        this._entries.set(key, entry);
        if (this._entries.size > MAX_ENTRIES) {
          this._entries.delete(this._entries.keys().next().value);
          this._dropped++;
        }
        if (this._streamBox?.checked && this._state === 'connected') {
          this._publishEntry(entry);
        }
      }
      this._scheduleRender();
    }

    _publishEntry(entry) {
      const me = this._me.value.trim();
      if (this._rpc && me) {
        this._rpc.publishTopic(`assistant/${me}/console`, entry);
      }
    }

    _scheduleRender() {
      if (this._renderTimer) return;
      this._renderTimer = setTimeout(() => {
        this._renderTimer = null;
        this._renderLog();
      }, 250);
    }

    _renderLog() {
      if (!this._logEl) return;
      this._summary.textContent =
        `${this._entries.size} distinct · ${this._total} total` +
        (this._dropped ? ` · ${this._dropped} dropped` : '');
      const rows = [...this._entries.values()].slice(-RECENT_SHOWN);
      this._logEl.replaceChildren(...rows.map((e) => {
        const row = document.createElement('div');
        row.className = 'row';
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = `×${e.count} `;
        const lvl = document.createElement('span');
        lvl.className = 'lvl-' + e.level;
        lvl.textContent = `[${e.level}] `;
        row.append(count, lvl, document.createTextNode(
          e.text + (e.source ? ` (${e.source})` : '')));
        return row;
      }));
    }

    // --- snapshots ---------------------------------------------------

    _sendSnapshot(id) {
      if (!this._rpc || this._state !== 'connected') return;
      const me = this._me.value.trim();
      if (!me) return;
      id = id || 'snap-' + Date.now().toString(36);
      const topic = `assistant/${me}/snapshot`;
      const meta = {
        url: location.href,
        title: document.title,
        screen: {
          width: screen.width, height: screen.height,
          availWidth: screen.availWidth, availHeight: screen.availHeight,
          colorDepth: screen.colorDepth,
        },
        viewport: {
          innerWidth: window.innerWidth, innerHeight: window.innerHeight,
          outerWidth: window.outerWidth, outerHeight: window.outerHeight,
        },
        devicePixelRatio: window.devicePixelRatio,
        scroll: { x: window.scrollX, y: window.scrollY },
      };
      const dom = document.documentElement.outerHTML;
      const total = Math.max(1, Math.ceil(dom.length / DOM_CHUNK));
      this._rpc.publishTopic(topic, { id, kind: 'begin', meta });
      for (let seq = 0; seq < total; seq++) {
        this._rpc.publishTopic(topic, {
          id, kind: 'dom', seq, total,
          text: dom.slice(seq * DOM_CHUNK, (seq + 1) * DOM_CHUNK),
        });
      }
      this._rpc.publishTopic(topic, {
        id, kind: 'console', entries: [...this._entries.values()],
      });
      this._rpc.publishTopic(topic, { id, kind: 'end' });
    }
  }

  window.RelayTool.registerFunction({
    id: 'assistant',
    version: VERSION,
    define() {
      if (!customElements.get(TAG)) {
        customElements.define(TAG, RelayAssistantPanel);
      }
      return TAG;
    },
  });
})();
