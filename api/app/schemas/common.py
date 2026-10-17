"""Shared schema building blocks."""

from decimal import Decimal
from typing import Annotated

from pydantic import BaseModel, ConfigDict, PlainSerializer

# Money is a Decimal on the server and a string in JSON, so no float rounding reaches the browser.
Money = Annotated[
    Decimal,
    PlainSerializer(lambda v: f"{v:.2f}", return_type=str, when_used="json"),
]


class Schema(BaseModel):
    """Base for request schemas."""

    model_config = ConfigDict(extra="forbid")


class ReadSchema(BaseModel):
    """Base for response schemas built from ORM objects."""

    model_config = ConfigDict(from_attributes=True)


class Page[T](BaseModel):
    items: list[T]
    total: int
    limit: int
    offset: int
