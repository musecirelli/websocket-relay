/**
 * Comms Shim — Relay Tool function: Script Inbox (v1.0.0)
 *
 * A loadable function: localhostServer serves this file at
 * /functions/scripts.js and lists it in the functions.list
 * catalog. The Relay Tool core loads it on demand; it defines
 * its panel component and registers with the core via
 * window.RelayTool.registerFunction. Functions version
 * independently of the tool — the tag name carries this version.
 *
 * Script Inbox: an email-style inbox for scripts. Deliveries
 * arrive as script.deliver JSON-RPC notifications on the topic
 * scripts/<username>, params {from, name, description, script}.
 * QoS 0: if this function is not enabled and connected when a
 * script is sent, it is lost — same rule as chat.
 *
 * Layout: a connection row (broker, connect button, status
 * light, "You are"), then the inbox: the script list on the
 * left, the detail on the right — name, sender, description,
 * the full script in a read-only monospace box, and Accept /
 * Deny buttons. Accept executes the script on the page (a
 * <script> element, page scope) exactly once. Entry states —
 * unread (bold), read (opened), run (accepted + executed),
 * denied (crossed out) — are CSS off data-state.
 */
(() => {
  const VERSION = '1.0.1';
  const TAG = `relay-scripts-panel-v${VERSION.replaceAll('.', '-')}`;

  class RelayScriptsPanel extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._rpc = null;
      this._unsubscribe = [];
      this._state = 'disconnected';
      this._entries = []; // newest first
      this._nextId = 1;
      this._selectedId = null;
    }

    connectedCallback() {
      const homeBroker = window.CommsShim?.brokerUrl || 'ws://127.0.0.1:8083';
      this.shadowRoot.innerHTML = `
        <style>
          ${window.RelayTool.panelCSS}
          .inbox { display: flex; flex-direction: column; height: 100%;
                   box-sizing: border-box; gap: 0.5rem; }
          .top { display: flex; align-items: center; gap: 0.4rem; }
          .top input { flex: 1; min-width: 0; padding: 0.4rem; font: inherit;
                       font-family: ui-monospace, Menlo, monospace;
                       font-size: 0.85rem; }
          .top label { color: var(--rt-muted, #777); font-size: 0.85rem; }
          .top input[name="me"] { flex: 0 1 7rem;
                       font-family: inherit; font-size: inherit; }
          .connect { padding: 0.4rem 0.6rem; font: inherit; cursor: pointer; }
          .light { width: 11px; height: 11px; border-radius: 50%; flex: none;
                   background: #d64545;
                   box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15) inset; }
          .inbox[data-state="connecting"] .light { background: #e3a008;
                   animation: pulse 900ms ease-in-out infinite; }
          .inbox[data-state="connected"] .light { background: #2da44e; }
          @keyframes pulse { 50% { opacity: 0.35; } }
          .body { flex: 1; display: flex; min-height: 0; gap: 0; }
          .list { width: 168px; flex: none; overflow-y: auto;
                  border: 1px solid var(--rt-border, #ddd); border-radius: 6px;
                  padding: 0.3rem; }
          .list .empty { padding: 0.4rem; color: var(--rt-muted, #777);
                         font-size: 0.85rem; }
          .item { display: block; width: 100%; text-align: left;
                  padding: 0.4rem 0.5rem; margin-bottom: 0.25rem;
                  border: 1px solid transparent; border-radius: 6px;
                  background: none; font: inherit; cursor: pointer;
                  color: var(--rt-text, #222); }
          .item:hover { background: var(--rt-hover, #e8e8ee); }
          .item[aria-selected="true"] {
            background: var(--rt-accent, #2f6fed); color: #fff; }
          .item .nm { display: block; overflow-wrap: anywhere; }
          .item .meta { display: block; font-size: 0.78rem;
                        color: var(--rt-muted, #777); }
          .item[aria-selected="true"] .meta { color: #dbe4fb; }
          .item[data-state="unread"] .nm { font-weight: 700; }
          .item[data-state="unread"] .nm::before {
            content: "● "; color: var(--rt-accent, #2f6fed); }
          .item[data-state="run"] .nm::after {
            content: " ✓ ran"; color: #2da44e; font-size: 0.78rem; }
          .item[data-state="denied"] .nm {
            text-decoration: line-through; color: var(--rt-muted, #777); }
          .detail { flex: 1; min-width: 0; display: flex;
                    flex-direction: column; gap: 0.4rem;
                    padding-left: 0.7rem; }
          .detail .hint { color: var(--rt-muted, #777); padding: 0.4rem 0; }
          .d-name { font-weight: 700; font-size: 1rem;
                    overflow-wrap: anywhere; }
          .d-from { color: var(--rt-muted, #777); font-size: 0.82rem; }
          .d-desc { font-size: 0.9rem; overflow-wrap: anywhere; }
          .d-script { flex: 1; min-height: 0; width: 100%;
                      box-sizing: border-box; resize: none;
                      font-family: ui-monospace, Menlo, monospace;
                      font-size: 0.8rem; padding: 0.5rem; }
          .actions { flex: none; display: flex; align-items: center;
                     gap: 0.4rem; }
          .actions button { padding: 0.4rem 0.9rem; font: inherit;
                            cursor: pointer; }
          .actions button:disabled { cursor: default; opacity: 0.5; }
          .actions .status { color: var(--rt-muted, #777);
                             font-size: 0.85rem; }
        </style>
        <div class="inbox panel" data-state="disconnected">
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
          <div class="body">
            <div class="list" part="list"></div>
            <div class="detail" part="detail"></div>
          </div>
        </div>`;

      this._root = this.shadowRoot.querySelector('.inbox');
      this._broker = this.shadowRoot.querySelector('input[name="broker"]');
      this._me = this.shadowRoot.querySelector('input[name="me"]');
      this._light = this.shadowRoot.querySelector('.light');
      this._listEl = this.shadowRoot.querySelector('.list');
      this._detailEl = this.shadowRoot.querySelector('.detail');

      this.shadowRoot.querySelector('.top').addEventListener('submit', (e) => {
        e.preventDefault();
        this._toggleConnect();
      });
      this._me.addEventListener('change', () => {
        if (this._rpc && this._state === 'connected') {
          this._rpc.unsubscribeTopic(`scripts/${this._subscribedAs}`);
          this._subscribeAs(this._me.value.trim());
        }
      });
      this._listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-entry-id]');
        if (btn) this._select(Number(btn.dataset.entryId));
      });
      this._detailEl.addEventListener('click', (e) => {
        const action = e.target.closest('button[data-action]')?.dataset.action;
        if (action === 'accept') this._accept();
        if (action === 'deny') this._deny();
      });

      this._renderList();
      this._renderDetail();
      // Starts disconnected, like Chat: the user clicks Connect.
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
      this._subscribedAs = null;
    }

    _setState(state) {
      this._state = state;
      this._root.dataset.state = state;
      this._broker.disabled = state !== 'disconnected';
      this.shadowRoot.querySelector('.connect').textContent =
        state === 'disconnected' ? 'Connect' : 'Disconnect';
      this._light.setAttribute('aria-label', {
        disconnected: 'Not connected',
        connecting: 'Connecting…',
        connected: 'Connected',
      }[state]);
    }

    _subscribeAs(name) {
      this._subscribedAs = name;
      if (name) this._rpc.subscribeTopic(`scripts/${name}`);
    }

    async _toggleConnect() {
      if (this._state === 'connected' || this._state === 'connecting') {
        this._teardown();
        this._setState('disconnected');
        return;
      }
      const url = this._broker.value.trim();
      const me = this._me.value.trim();
      if (!url || !me) return;
      if (!window.mqtt || !window.MqttRpc) return;
      this._setState('connecting');
      const rpc = new window.MqttRpc(url,
        `${window.CommsShim?.clientId || 'web'}-scripts`);
      this._rpc = rpc;
      this._unsubscribe.push(rpc.onStateChange((state) => {
        if (this._rpc !== rpc) return;
        if (state === 'connected') this._setState('connected');
        else if (state === 'disconnected' && this._state === 'connected') {
          this._setState('disconnected');
        }
      }));
      this._unsubscribe.push(rpc.onNotification('script.deliver', (p) => {
        this._addEntry(p);
      }));
      try {
        await rpc.connect();
        this._subscribeAs(me);
        this._setState('connected');
      } catch {
        this._teardown();
        this._setState('disconnected');
      }
    }

    _addEntry(p) {
      const entry = {
        id: this._nextId++,
        from: typeof p?.from === 'string' ? p.from : 'unknown',
        name: typeof p?.name === 'string' && p.name ? p.name : '(unnamed script)',
        description: typeof p?.description === 'string' ? p.description : '',
        script: typeof p?.script === 'string' ? p.script : '',
        state: 'unread',
      };
      this._entries.unshift(entry);
      this._renderList();
    }

    _selected() {
      return this._entries.find((e) => e.id === this._selectedId) ?? null;
    }

    _select(id) {
      const entry = this._entries.find((e) => e.id === id);
      if (!entry) return;
      this._selectedId = id;
      if (entry.state === 'unread') entry.state = 'read';
      this._renderList();
      this._renderDetail();
    }

    _accept() {
      const entry = this._selected();
      if (!entry || entry.state === 'run' || entry.state === 'denied') return;
      // Execute on the page, in page scope — the script element
      // runs as it is appended; removing it afterwards does not
      // undo the execution.
      const el = document.createElement('script');
      el.textContent = entry.script;
      document.documentElement.appendChild(el);
      el.remove();
      entry.state = 'run';
      this._renderList();
      this._renderDetail();
    }

    _deny() {
      const entry = this._selected();
      if (!entry || entry.state === 'run' || entry.state === 'denied') return;
      entry.state = 'denied';
      this._renderList();
      this._renderDetail();
    }

    _renderList() {
      this._listEl.innerHTML = this._entries.length
        ? this._entries.map((e) => `
            <button type="button" class="item" data-entry-id="${e.id}"
                    data-state="${e.state}"
                    aria-selected="${String(this._selectedId === e.id)}">
              <span class="nm"></span>
              <span class="meta"></span>
            </button>`).join('')
        : '<div class="empty">No scripts yet</div>';
      // Names and senders are data, never markup: fill via textContent.
      this._listEl.querySelectorAll('.item').forEach((btn, i) => {
        const e = this._entries[i];
        btn.querySelector('.nm').textContent = e.name;
        btn.querySelector('.meta').textContent = `from ${e.from}`;
      });
    }

    _renderDetail() {
      const entry = this._selected();
      if (!entry) {
        this._detailEl.innerHTML =
          '<div class="hint">Select a script to review it. Nothing runs until you Accept it.</div>';
        return;
      }
      const decided = entry.state === 'run' || entry.state === 'denied';
      this._detailEl.innerHTML = `
        <div class="d-name"></div>
        <div class="d-from"></div>
        <div class="d-desc"></div>
        <textarea class="d-script" readonly spellcheck="false"></textarea>
        <div class="actions">
          <button type="button" data-action="accept" ${decided ? 'disabled' : ''}>Accept</button>
          <button type="button" data-action="deny" ${decided ? 'disabled' : ''}>Deny</button>
          <span class="status">${
            entry.state === 'run' ? 'Ran on this page'
            : entry.state === 'denied' ? 'Denied — not run'
            : 'Review the script, then Accept to run it'}</span>
        </div>`;
      this._detailEl.querySelector('.d-name').textContent = entry.name;
      this._detailEl.querySelector('.d-from').textContent = `from ${entry.from}`;
      this._detailEl.querySelector('.d-desc').textContent = entry.description;
      this._detailEl.querySelector('.d-script').value = entry.script;
    }
  }

  window.RelayTool?.registerFunction({
    id: 'scripts',
    version: VERSION,
    define() {
      if (!customElements.get(TAG)) {
        customElements.define(TAG, RelayScriptsPanel);
      }
      return TAG;
    },
  });
})();
