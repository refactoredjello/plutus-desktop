"""Owned by Wave 3 (auth). Stubs define the contract."""

from fastapi import APIRouter, status

from app.errors import NotImplementedYetError
from app.schemas.auth import LoginRequest, SessionRead

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", status_code=status.HTTP_204_NO_CONTENT)
def login(body: LoginRequest) -> None:
    raise NotImplementedYetError


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout() -> None:
    raise NotImplementedYetError


@router.get("/session", response_model=SessionRead)
def get_session() -> SessionRead:
    raise NotImplementedYetError
