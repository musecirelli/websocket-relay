// Package websocketrelay holds module-level assets for the Comms Shim.
//
// The client snippet lives in client/snippet.js as the single source
// of truth. It is embedded here, at the module root, because go:embed
// patterns cannot reference parent directories — server/gui.go (in
// ./server) could not embed ../client/snippet.js directly.
package websocketrelay

import _ "embed"

// ClientSnippet is the drop-in browser snippet (client/snippet.js),
// served by the GUI so users can copy it into a developer console.
//
//go:embed client/snippet.js
var ClientSnippet string
