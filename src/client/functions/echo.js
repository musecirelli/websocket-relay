/**
 * Comms Shim — Relay Tool function: Echo (v1.0.0)
 *
 * A loadable function: localhostServer serves this file at
 * /functions/echo.js and lists it in the functions.list catalog.
 * The Relay Tool core loads it on demand; it defines its panel
 * component and registers with the core via
 * window.RelayTool.registerFunction. Functions version
 * independently of the tool — the tag name carries this version.
 *
 * Echo: a text field, a target selector (which server answers),
 * a Send button, and a readonly log. Talks to the servers through
 * the snippet's shared MqttRpc (window.CommsShim.rpc).
 */
(() => {
  const VERSION = '1.0.0';
  const TAG = `relay-echo-panel-v${VERSION.replaceAll('.', '-')}`;

  class RelayEchoPanel extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
      this.shadowRoot.innerHTML = `
        <style>
          ${window.RelayTool.panelCSS}
          form { display: flex; gap: 0.4rem; margin-bottom: 0.5rem; }
          input { flex: 1; padding: 0.4rem; font: inherit; }
          select { padding: 0.4rem; font: inherit; }
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
            <select name="target" title="Which server answers">
              <option value="localhost">localhost</option>
              <option value="remote">remote</option>
            </select>
            <button type="submit">Send</button>
          </form>
          <textarea readonly placeholder="Echoes will appear here"></textarea>
        </div>`;
      const form = this.shadowRoot.querySelector('form');
      const input = this.shadowRoot.querySelector('input');
      const target = this.shadowRoot.querySelector('select[name="target"]');
      this._log = this.shadowRoot.querySelector('textarea');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const message = input.value;
        if (!message) return;
        this._append(`> [${target.value}] ${message}`);
        try {
          const rpc = window.CommsShim?.rpc;
          if (!rpc) throw new Error('not connected to localhostServer');
          const result = await rpc.call('echo', message, target.value);
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

  window.RelayTool?.registerFunction({
    id: 'echo',
    version: VERSION,
    define() {
      if (!customElements.get(TAG)) {
        customElements.define(TAG, RelayEchoPanel);
      }
      return TAG;
    },
  });
})();
