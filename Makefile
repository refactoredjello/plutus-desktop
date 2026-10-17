.PHONY: help up down logs migrate revision test test-api test-web lint fmt typecheck openapi check check-server check-desktop check-parity parity parity-self import-check dev-server password-hash demo-data demo-clear

help: ## Show targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

up: ## Start the full dev stack
	docker compose up -d --build

down: ## Stop the stack
	docker compose down

logs: ## Tail logs
	docker compose logs -f api web

migrate: ## Apply migrations (release step)
	docker compose run --rm migrate

revision: ## Orchestrator only: autogenerate a migration, e.g. make revision m="add x"
	cd api && uv run alembic revision --autogenerate -m "$(m)"

test: test-api test-web ## Run all tests

test-api: ## Backend tests against the compose Postgres
	@nc -z localhost 5432 2>/dev/null || docker compose up -d db
	cd api && uv run pytest

test-web: ## Frontend tests
	cd web && npm test

lint: ## Lint backend and frontend
	cd api && uv run ruff check . && uv run ruff format --check .
	cd web && npm run lint

fmt: ## Format backend
	cd api && uv run ruff format . && uv run ruff check --fix .

typecheck: ## mypy strict and tsc
	cd api && uv run mypy app
	cd web && npm run typecheck

openapi: ## Regenerate the OpenAPI spec (from server/) and TypeScript client after schema changes
	cd server && npm run openapi
	cd web && npm run gen:api

check-server: ## Lint, typecheck, and test the TypeScript server
	cd server && npm run check

dev-server: ## Run the TypeScript server headless on :8000, serving web/dist
	cd server && npm run dev

check-desktop: ## Lint, typecheck, and test the Electron shell (needs no build)
	cd desktop && npm run check

check-parity: ## Lint, typecheck, and unit-test the parity harness (starts no app, needs no Postgres)
	node_modules/.bin/oxlint -c tools/parity/.oxlintrc.json tools/parity
	node_modules/.bin/tsc -p tools/parity/tsconfig.json
	node_modules/.bin/vitest run --config tools/parity/vitest.config.ts

parity: ## Python vs TypeScript parity run on demo data; writes tools/parity/report.md
	node_modules/.bin/tsx tools/parity/run.ts

parity-self: ## Python vs Python self-check of the parity harness; must report zero differences
	node_modules/.bin/tsx tools/parity/run.ts --self-check

import-check: ## Postgres export to SQLite import on demo data (plutus_export); counts and monthly report must match
	node_modules/.bin/tsx tools/parity/import_check.ts

check: lint typecheck test check-server check-desktop check-parity ## Everything CI runs

password-hash: ## Print an argon2 hash for APP_PASSWORD_HASH
	@cd api && uv run python -c 'import getpass; from argon2 import PasswordHasher; print("APP_PASSWORD_HASH=\x27" + PasswordHasher().hash(getpass.getpass("Password: ")) + "\x27")'

demo-data: ## Load fake demo transactions into the dev database
	cd api && uv run python -m app.demo load

demo-clear: ## Remove demo data
	cd api && uv run python -m app.demo clear
