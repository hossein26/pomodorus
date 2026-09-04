.DEFAULT_GOAL := help
.PHONY: help dev electron build dist test clean

## help: list targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //' | awk -F': ' '{printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'

## dev: run the Vite client
dev:
	cd client && npm run dev

## electron: run the Mac shell against the dev server
# Terminal one runs `make dev`; this is terminal two. The shell loads
# http://localhost:5174, so the page it shows is the code being edited.
electron:
	cd client && npm run electron

## build: typecheck and build the offline web bundle into client/dist
build:
	cd client && npm run build

## dist: build Pomodorus-*.dmg (and .zip) for Apple Silicon into client/release
dist: build
	cd client && npx electron-builder --mac --publish never
	@echo "artifact: client/release/Pomodorus-*-arm64.dmg"

## test: run the Vitest suite
test:
	cd client && npm test

## clean: remove build output
clean:
	rm -rf client/dist client/release
