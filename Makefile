.PHONY: help up down logs migrate revision test test-api test-web lint fmt typecheck openapi check password-hash demo-data demo-clear

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
	docker compose up -d db
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

openapi: ## Regenerate the OpenAPI spec and TypeScript client after schema changes
	cd api && uv run python -m app.export_openapi ../web/src/api/openapi.json
	cd web && npm run gen:api

check: lint typecheck test ## Everything CI runs

password-hash: ## Print an argon2 hash for APP_PASSWORD_HASH
	@cd api && uv run python -c 'import getpass; from argon2 import PasswordHasher; print("APP_PASSWORD_HASH=\x27" + PasswordHasher().hash(getpass.getpass("Password: ")) + "\x27")'

demo-data: ## Load fake demo transactions into the dev database
	cd api && uv run python -m app.demo load

demo-clear: ## Remove demo data
	cd api && uv run python -m app.demo clear
