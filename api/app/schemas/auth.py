from pydantic import BaseModel

from app.schemas.common import Schema


class LoginRequest(Schema):
    password: str


class SessionRead(BaseModel):
    authenticated: bool
