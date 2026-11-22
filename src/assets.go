// Package websocketrelay holds module-level assets for the Comms Shim.
//
// The client files live in client/ as the single source of truth.
// They are embedded here, at the module root, because go:embed
// patterns cannot reference parent directories — server/gui.go (in
// ./server) could not embed ../client/snippet.js directly.
package websocketrelay

import _ "embed"

// ClientSnippet is the drop-in browser snippet (client/snippet.js),
// the human-readable source. Kept for reference and debugging; the
// GUI hands out the compiled form below.
//
//go:embed client/snippet.js
var ClientSnippet string

// ClientSnippetMin is the snippet as served by the GUI: compiled
// from client/snippet.js with Google Closure Compiler (mise task
// build-snippet). It is committed so a fresh clone builds without
// the compiler installed; make rebuilds it when the source is newer.
//
//go:embed client/snippet.min.js
var ClientSnippetMin string

// RelayToolJS is the Relay Tool web-components app
// (client/relay-tool.js), served by localhostServer at
// GET /relay-tool.js and loaded by the snippet.
//
//go:embed client/relay-tool.js
var RelayToolJS string

// MQTTJS is the vendored MQTT.js browser build (v5.16.1, MIT,
// https://github.com/mqttjs/MQTT.js), served by localhostServer at
// GET /mqtt.min.js. The snippet loads MQTT.js from a CDN first and
// falls back to this copy, so the vendored file only needs to
// exist and be a working build, not be rebuilt by make.
//
//go:embed client/mqtt.min.js
var MQTTJS string
