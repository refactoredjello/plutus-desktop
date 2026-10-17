"""Goals and savings suggestions (R8)."""

from typing import Annotated

from fastapi import APIRouter, Depends, status

from app.deps import AppSettings, DbSession
from app.providers.llm import get_llm_provider
from app.providers.llm.base import LLMProvider
from app.schemas.goals import (
    GoalCreate,
    GoalRead,
    GoalUpdate,
    SuggestionRead,
    SuggestionUpdate,
)
from app.services import goals as goals_service
from app.services import suggestions as suggestions_service

router = APIRouter(tags=["goals"])


def get_llm(settings: AppSettings) -> LLMProvider:
    """Overridable in tests with app.dependency_overrides."""
    return get_llm_provider(settings)


LLM = Annotated[LLMProvider, Depends(get_llm)]


@router.get("/goals", response_model=list[GoalRead])
def list_goals(db: DbSession) -> list[GoalRead]:
    return [goals_service.to_read(db, g) for g in goals_service.list_goals(db)]


@router.post("/goals", response_model=GoalRead, status_code=status.HTTP_201_CREATED)
def create_goal(body: GoalCreate, db: DbSession) -> GoalRead:
    return goals_service.to_read(db, goals_service.create_goal(db, body))


@router.get("/goals/{goal_id}", response_model=GoalRead)
def get_goal(goal_id: int, db: DbSession) -> GoalRead:
    return goals_service.to_read(db, goals_service.get_goal(db, goal_id))


@router.patch("/goals/{goal_id}", response_model=GoalRead)
def update_goal(goal_id: int, body: GoalUpdate, db: DbSession) -> GoalRead:
    return goals_service.to_read(db, goals_service.update_goal(db, goal_id, body))


@router.get("/goals/{goal_id}/suggestions", response_model=list[SuggestionRead])
def list_suggestions(goal_id: int, db: DbSession) -> list[SuggestionRead]:
    return [
        SuggestionRead.model_validate(s) for s in suggestions_service.list_suggestions(db, goal_id)
    ]


@router.post(
    "/goals/{goal_id}/suggestions",
    response_model=list[SuggestionRead],
    status_code=status.HTTP_201_CREATED,
)
def generate_suggestions(
    goal_id: int, db: DbSession, settings: AppSettings, llm: LLM
) -> list[SuggestionRead]:
    """Ask the LLM for new savings suggestions from aggregates only."""
    created = suggestions_service.generate_suggestions(db, goal_id, settings, llm)
    return [SuggestionRead.model_validate(s) for s in created]


@router.patch("/suggestions/{suggestion_id}", response_model=SuggestionRead)
def update_suggestion(suggestion_id: int, body: SuggestionUpdate, db: DbSession) -> SuggestionRead:
    return SuggestionRead.model_validate(
        suggestions_service.update_suggestion(db, suggestion_id, body.status)
    )
