.PHONY: all validate test search help

OKF_BIN ?= $(shell command -v okf 2>/dev/null || echo "bin/okf")
BUNDLE := knowledge

all: validate

## validate: Run strict OKF v0.2 validation on the knowledge/ bundle
validate:
	@$(OKF_BIN) validate $(BUNDLE) --strict --drift

test: validate
	bun test

## search: Search project memory (e.g. make search q="auth")
search:
	@$(OKF_BIN) search "$(q)" $(BUNDLE)

help:
	@echo "Project Memory Commands:"
	@echo "  make validate       Validate knowledge/ bundle"
	@echo "  make search q=\"...\" Search project memory"

.PHONY: build install
BIN_DIR ?= $(HOME)/.local/bin
## build: Compile separate self-contained CLI and TUI executables
build:
	bun run tools/build.ts

## install: Rebuild and atomically replace binaries at stable paths
install: build
	mkdir -p "$(BIN_DIR)"
	install -m 755 dist/cusage "$(BIN_DIR)/cusage.new"
	mv -f "$(BIN_DIR)/cusage.new" "$(BIN_DIR)/cusage"
	install -m 755 dist/cusage-tui "$(BIN_DIR)/cusage-tui.new"
	mv -f "$(BIN_DIR)/cusage-tui.new" "$(BIN_DIR)/cusage-tui"
