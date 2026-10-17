"""FastAPI app factory. Router registration is pre-wired here so feature briefs never edit it."""

import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import APIRoute

from app.config import get_settings
from app.errors import register_error_handlers
from app.logging import configure_logging
from app.routers import (
    accounts,
    auth,
    categories,
    changes,
    goals,
    health,
    manual_entries,
    projection,
    recurring,
    reports,
    settings,
    sync,
    transactions,
)
from app.scheduler import start_scheduler, stop_scheduler

API_PREFIX = "/api"

ROUTERS = [
    health.router,
    auth.router,
    accounts.router,
    sync.router,
    settings.router,
    transactions.router,
    categories.router,
    changes.router,
    reports.router,
    projection.router,
    recurring.router,
    manual_entries.router,
    goals.router,
]


def operation_id(route: APIRoute) -> str:
    """Stable operation IDs so the generated TypeScript client has readable names."""
    return route.name


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    if settings.scheduler_enabled:
        start_scheduler(settings)
    yield
    stop_scheduler()


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings)

    app = FastAPI(
        title="Plutus API",
        version="0.1.0",
        lifespan=lifespan,
        generate_unique_id_function=operation_id,
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def request_id(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        structlog.contextvars.bind_contextvars(request_id=rid)
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.clear_contextvars()
        response.headers["x-request-id"] = rid
        return response

    register_error_handlers(app)
    for router in ROUTERS:
        app.include_router(router, prefix=API_PREFIX)
    return app


app = create_app()
