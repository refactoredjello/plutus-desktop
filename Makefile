.PHONY: help check check-web check-server check-desktop openapi dev dev-server dist smoke demo-data demo-clear update rollback quit-plutus

help: ## Show targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

check: ## Everything CI runs: lint, types, and tests for web, server, and desktop
	npm run check

check-web: ## Lint, typecheck, and test the web app
	cd web && npm run lint && npm run typecheck && npm test

check-server: ## Lint, typecheck, and test the server
	cd server && npm run check

check-desktop: ## Lint, typecheck, and test the Electron shell (needs no build)
	cd desktop && npm run check

openapi: ## Regenerate the OpenAPI spec (from server/) and the TypeScript client after schema changes
	cd server && npm run openapi
	cd web && npm run gen:api

dev: ## Build web, server, and the shell, then open the desktop app (data in "Plutus Dev")
	cd desktop && npm run dev

dev-server: ## Run the headless server on :8000 with reload, serving web/dist (build web first)
	cd server && npm run dev

dist: ## Package the macOS app into desktop/release/ (ad hoc signed unless a signing identity is set)
	cd desktop && npm run dist

smoke: ## Open the desktop app on a throwaway data dir and check the SPA reaches /api/health
	cd desktop && npm run smoke

demo-data: ## Load fake demo data into the headless server's database (PLUTUS_DATA_DIR / PLUTUS_DB_PATH)
	cd server && npm run demo -- load

demo-clear: ## Remove the demo data
	cd server && npm run demo -- clear

# Quit the installed app gracefully (it closes its database on quit) and wait up to 30 s.
quit-plutus:
	@if pgrep -x Plutus >/dev/null; then \
		echo "Quitting Plutus..."; osascript -e 'quit app "Plutus"' >/dev/null; \
		for i in $$(seq 1 30); do pgrep -x Plutus >/dev/null || break; sleep 1; done; \
		if pgrep -x Plutus >/dev/null; then echo "Plutus is still running; quit it and try again." >&2; exit 1; fi; \
	fi

# Looks up the release (--check) before quitting Plutus, so a failed lookup leaves it running.
update: ## Quit Plutus, install the latest release (or VERSION=x.y.z) with a data copy and rollback zip, reopen it
	cd desktop && npm run --silent update:app -- --check $(VERSION)
	@$(MAKE) --no-print-directory quit-plutus
	cd desktop && npm run update:app -- $(VERSION)
	open -a /Applications/Plutus.app

rollback: quit-plutus ## Quit Plutus, reinstall the app the last update replaced, reopen it
	cd desktop && npm run update:app -- --rollback
	open -a /Applications/Plutus.app
