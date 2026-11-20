/**
 * Comms Shim — Relay Tool v0.2.0
 *
 * Served by localhostServer (GET /relay-tool.js) and loaded by the
 * client snippet. A floating tool window built from standard web
 * components — vanilla JS/HTML/CSS, no frameworks.
 *
 * Components (tag names carry the version — see below):
 *   <relay-tool-v0-2-0>           the floating window (drag, resize, close)
 *   <relay-function-list-v0-2-0>  left panel: the available functions
 *   <relay-echo-panel-v0-2-0>     the echo function panel (right side)
 *
 * Versioned tags: a custom element name can only ever be defined
 * once per page, so the tag names are suffixed with the tool
 * version (relay-tool-v0-2-0). Different versions of the tool can
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
  const VERSION = '0.2.0';

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
