from datetime import datetime

from pydantic import Field

from app.models.base import Essentiality, RuleMatchType
from app.schemas.common import ReadSchema, Schema


class CategoryRead(ReadSchema):
    id: int
    primary: str
    detailed: str
    label: str
    description: str | None
    is_hidden: bool
    is_custom: bool


class CategoryCreate(Schema):
    primary: str = Field(min_length=1, max_length=100)
    label: str = Field(min_length=1, max_length=100)
    description: str | None = None


class CategoryUpdate(Schema):
    label: str | None = Field(default=None, min_length=1, max_length=100)
    is_hidden: bool | None = None


class RuleRead(ReadSchema):
    id: int
    match_type: RuleMatchType
    pattern: str
    category_id: int
    essentiality: Essentiality | None
    created_at: datetime
