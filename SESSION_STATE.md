# SESSION_STATE — websocket-relay

## Objective
Establish the project's shared terminology and record the GUI
architecture, per Steve's direction (2026-11-17):

- The client-side WebSocket server is named **localhostServer**.
- The whole local system is the **Comms Shim**.
- localhostServer will also serve a **GUI** at
  `http://localhost:<random port>` — the port is chosen at startup and
  the URL is printed to the console when the server is run from the
  command line. For now the GUI is a single simple page: "here's the
  code snippet to drop in your developer console", with the snippet
  code shown. It will eventually become a web app built with vanilla
  JS, CSS, HTML and standard web components.
- README.md documents these terms.
- The SESSION_STATE protocol itself is recorded in Muse's AGENTS.md.

Acceptance criteria:
- README.md has a Terminology section defining: Comms Shim,
  localhostServer, client snippet, GUI.
- This file exists at the project root with the required sections.
- Existing behavior unchanged: build + tests still pass on the
  MacBook Dev machine.
- Work is committed (Signed-off-by) and delivered to Steve as a
  `git format-patch` series on top of commit `2788929` (the bundle
  base he cloned).

## Active Diffs
- `SESSION_STATE.md` — new (this file), created before any source edits.
- `README.md` — Terminology section added (line 19) + Roadmap updated
  (Step 2 = GUI). Verified on the Mac; ready to commit.
- (Outside the repo) `~/AGENTS.md` — SESSION_STATE protocol section
  added 2026-11-17 at Steve's instruction.

## Decided Architecture
- **Comms Shim** = the whole local system: localhostServer + GUI +
  client snippet. Do not reopen the name without Steve.
- **localhostServer**: Go, standard library only, JSON-RPC 2.0 over
  WebSocket on localhost. Methods so far: `echo`, `ping`.
- **Client snippet**: drop-in JavaScript (`client/snippet.js`) pasted
  into a web page or the browser developer console; connects to
  localhostServer.
- **GUI**: served by localhostServer on a *separate random port*
  (OS-assigned), URL printed at startup; stack is vanilla JS/CSS/HTML
  + standard web components (no frameworks). Initial page shows the
  client snippet to copy into the dev console.
- Collaboration: Linux kernel style — git bundle bootstrap,
  `git format-patch` / `git am` exchange, review in chat, no GitHub
  (see WORKFLOW.md).
- State tracking: this file is updated before source edits; gates are
  only checked with raw terminal output as evidence.

## Verification Gates
- [x] README.md Terminology section present — raw output:
      `19:## Terminology` (grep, 2026-11-17).
- [x] `go vet ./...` clean on the MacBook Dev machine — raw output:
      `VET_OK` / `BUILD_OK` (fresh build to /tmp/websocket-relay).
- [x] `tests/test_client.py` ALL PASS against a fresh Mac build —
      raw output: 5× PASS (echo string, echo id, echo object, ping,
      unknown method -32601), `ALL PASS`.
- [ ] Patch series applies cleanly (`git am` check against the
      bundle base `2788929`) — pending the commit below.

## Handoff Note
Next single command to execute (on the Mac, maintainer tree):
`cd ~/Sync/projects/websocket-relay && git add README.md SESSION_STATE.md && git commit -s -m "docs: define Comms Shim terminology and session state"`
