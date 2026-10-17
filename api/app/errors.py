"""Domain errors raised by services, mapped to RFC 9457 problem details."""

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse


class DomainError(Exception):
    status_code = status.HTTP_400_BAD_REQUEST
    title = "Bad request"

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class NotFoundError(DomainError):
    status_code = status.HTTP_404_NOT_FOUND
    title = "Not found"


class ConflictError(DomainError):
    status_code = status.HTTP_409_CONFLICT
    title = "Conflict"


class ProviderError(DomainError):
    status_code = status.HTTP_502_BAD_GATEWAY
    title = "Upstream provider error"


class NotImplementedYetError(DomainError):
    """Raised by Wave 0 route stubs until the owning agent implements them."""

    status_code = status.HTTP_501_NOT_IMPLEMENTED
    title = "Not implemented"

    def __init__(self, detail: str = "Not implemented yet") -> None:
        super().__init__(detail)


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(DomainError)
    async def handle_domain_error(request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            media_type="application/problem+json",
            content={
                "type": "about:blank",
                "title": exc.title,
                "status": exc.status_code,
                "detail": exc.detail,
                "instance": request.url.path,
            },
        )
