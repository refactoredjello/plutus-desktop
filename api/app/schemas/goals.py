from datetime import date, datetime

from pydantic import BaseModel, Field

from app.models.base import SuggestionStatus
from app.schemas.common import Money, ReadSchema, Schema


class GoalProgress(BaseModel):
    saved_so_far: Money
    remaining: Money
    months_left: int
    required_monthly: Money
    actual_monthly_average: Money
    on_track: bool


class GoalRead(ReadSchema):
    id: int
    name: str
    target_amount: Money
    target_date: date
    starting_amount: Money
    is_active: bool
    progress: GoalProgress | None


class GoalCreate(Schema):
    name: str = Field(min_length=1, max_length=255)
    target_amount: Money = Field(gt=0)
    target_date: date


class GoalUpdate(Schema):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    target_amount: Money | None = Field(default=None, gt=0)
    target_date: date | None = None
    is_active: bool | None = None


class SuggestionRead(ReadSchema):
    id: int
    goal_id: int
    text: str
    category_id: int | None
    estimated_monthly_saving: Money | None
    status: SuggestionStatus
    created_at: datetime


class SuggestionUpdate(Schema):
    status: SuggestionStatus
