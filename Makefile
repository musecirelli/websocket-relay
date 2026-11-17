# websocket-relay — build/run entry points.
#
# Layout: the Go module lives in src/; all build artifacts go to
# build/ (gitignored). Run `make` targets from the repo root.

GO      ?= go
SRC     := src
BIN     := websocket-relay
DEBUG   := build/debug/$(BIN)
RELEASE := build/release/$(BIN)

.PHONY: build build-release run run-release test vet clean

build: ## Debug build: race detector, optimizations off -> build/debug/
	mkdir -p build/debug
	cd $(SRC) && $(GO) build -race -gcflags="all=-N -l" -o ../$(DEBUG) ./server

build-release: ## Production build: static, trimmed, stripped -> build/release/
	mkdir -p build/release
	cd $(SRC) && CGO_ENABLED=0 $(GO) build -trimpath -ldflags="-s -w" -o ../$(RELEASE) ./server

run: ## Run for debugging (race detector, nothing kept)
	cd $(SRC) && $(GO) run -race ./server

run-release: build-release ## Build the production binary and run it
	./$(RELEASE)

test: ## Run the Go test suite
	cd $(SRC) && $(GO) test ./...

vet: ## Run go vet
	cd $(SRC) && $(GO) vet ./...

clean: ## Remove all build artifacts
	rm -rf build
