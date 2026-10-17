"""Savings goals and their progress (R8)."""

from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import DomainError, NotFoundError
from app.models import Goal
from app.schemas.goals import GoalCreate, GoalProgress, GoalRead, GoalUpdate
from app.services import schedule
from app.services.aggregates import ZERO, current_total_balance, month_range, monthly_totals

COMPLETE_MONTHS_FOR_AVERAGE = 3


def previous_complete_months(count: int) -> list[str]:
    """The `count` calendar months before the current one, oldest first."""
    last_complete = schedule.today().replace(day=1) - timedelta(days=1)
    return month_range(last_complete, count)


def months_between(start: date, end: date) -> int:
    """Whole calendar months from start to end; 0 if end is not after start."""
    if end <= start:
        return 0
    months = (end.year - start.year) * 12 + (end.month - start.month)
    if end.day < start.day:
        months -= 1
    return max(months, 0)


def _cents(value: Decimal) -> Decimal:
    return value.quantize(ZERO)


def compute_progress(db: Session, goal: Goal) -> GoalProgress:
    saved = current_total_balance(db) - goal.starting_amount
    remaining = max(goal.target_amount - saved, ZERO)
    months_left = months_between(schedule.today(), goal.target_date)
    required = remaining / max(months_left, 1)
    nets = [
        m.net for m in monthly_totals(db, previous_complete_months(COMPLETE_MONTHS_FOR_AVERAGE))
    ]
    actual = sum(nets, ZERO) / len(nets)
    return GoalProgress(
        saved_so_far=_cents(saved),
        remaining=_cents(remaining),
        months_left=months_left,
        required_monthly=_cents(required),
        actual_monthly_average=_cents(actual),
        on_track=_cents(actual) >= _cents(required),
    )


def to_read(db: Session, goal: Goal) -> GoalRead:
    return GoalRead(
        id=goal.id,
        name=goal.name,
        target_amount=goal.target_amount,
        target_date=goal.target_date,
        starting_amount=goal.starting_amount,
        is_active=goal.is_active,
        progress=compute_progress(db, goal),
    )


def get_goal(db: Session, goal_id: int) -> Goal:
    goal = db.get(Goal, goal_id)
    if goal is None:
        raise NotFoundError(f"Goal {goal_id} not found")
    return goal


def list_goals(db: Session) -> list[Goal]:
    stmt = select(Goal).order_by(Goal.is_active.desc(), Goal.target_date, Goal.id)
    return list(db.scalars(stmt))


def create_goal(db: Session, body: GoalCreate) -> Goal:
    if body.target_date <= schedule.today():
        raise DomainError("target_date must be in the future")
    goal = Goal(
        name=body.name,
        target_amount=body.target_amount,
        target_date=body.target_date,
        starting_amount=current_total_balance(db),
    )
    db.add(goal)
    db.commit()
    return goal


def update_goal(db: Session, goal_id: int, body: GoalUpdate) -> Goal:
    goal = get_goal(db, goal_id)
    changes = body.model_dump(exclude_unset=True)
    for name in ("name", "target_amount", "target_date", "is_active"):
        if name in changes and changes[name] is None:
            raise DomainError(f"{name} cannot be null")
    new_date = changes.get("target_date")
    if new_date is not None and new_date != goal.target_date and new_date <= schedule.today():
        raise DomainError("target_date must be in the future")
    for name, value in changes.items():
        setattr(goal, name, value)
    db.commit()
    return goal
