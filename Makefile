# websocket-relay — build/run entry points.
#
# Layout: the Go module lives in src/; all build artifacts go to
# build/ (gitignored). Run `make` targets from the repo root.
# `make help` lists every target with its description.

GO      ?= go
SRC     := src
BIN     := websocket-relay
DEBUG   := build/debug/$(BIN)
RELEASE := build/release/$(BIN)
REMOTE_BIN     := remote-server
DEBUG_REMOTE   := build/debug/$(REMOTE_BIN)
RELEASE_REMOTE := build/release/$(REMOTE_BIN)
SNIPPET_SRC := src/client/snippet.js
MIN_SNIPPET := src/client/snippet.min.js

.DEFAULT_GOAL := build

.PHONY: help tools snippet build build-release run run-release run-remote test vet clean

help: ## Show this help (each target is documented by the comment on its own line)
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "%-16s %s\n", $$1, $$2}'

tools: ## Install the pinned toolchains via mise (Go, Node, Java, Closure Compiler)
	mise install

# The GUI hands out the Closure-compiled snippet. The compiled file
# is committed, so this only runs when the source is newer; if the
# compiler is missing at that point, stop and ask for `mise install`
# instead of failing obscurely inside the build.
$(MIN_SNIPPET): $(SNIPPET_SRC)
	@if mise exec -- google-closure-compiler --version >/dev/null 2>&1; then \
		echo "Compiling $(SNIPPET_SRC) with Closure Compiler (mise task build-snippet)..."; \
		mise run build-snippet; \
	else \
		echo "Closure Compiler is not installed, and $(MIN_SNIPPET) is out of date."; \
		echo "Please install the project tools, then re-run make:"; \
		echo "    mise install    # or: make tools  (mise itself: https://mise.jdx.dev)"; \
		exit 1; \
	fi

snippet: $(MIN_SNIPPET) ## Recompile the client snippet with Closure Compiler (via mise)

build: $(MIN_SNIPPET) ## Debug build (server + Remote Server): race detector, optimizations off -> build/debug/
	mkdir -p build/debug
	cd $(SRC) && $(GO) build -race -gcflags="all=-N -l" -o ../$(DEBUG) ./server
	cd $(SRC) && $(GO) build -race -gcflags="all=-N -l" -o ../$(DEBUG_REMOTE) ./remoteserver

build-release: $(MIN_SNIPPET) ## Production build (server + Remote Server): static, trimmed, stripped -> build/release/
	mkdir -p build/release
	cd $(SRC) && CGO_ENABLED=0 $(GO) build -trimpath -ldflags="-s -w" -o ../$(RELEASE) ./server
	cd $(SRC) && CGO_ENABLED=0 $(GO) build -trimpath -ldflags="-s -w" -o ../$(RELEASE_REMOTE) ./remoteserver

run: $(MIN_SNIPPET) ## Run for debugging (race detector, nothing kept)
	cd $(SRC) && $(GO) run -race ./server

run-release: build-release ## Build the production binary and run it
	./$(RELEASE)

run-remote: ## Run the Remote Server (Chat relay far end) for debugging
	cd $(SRC) && $(GO) run ./remoteserver

test: $(MIN_SNIPPET) ## Run the Go test suite
	cd $(SRC) && $(GO) test ./...

vet: ## Run go vet
	cd $(SRC) && $(GO) vet ./...

clean: ## Remove all build artifacts
	rm -rf build
