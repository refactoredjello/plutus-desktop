from importlib.metadata import PackageNotFoundError, version

from fastapi import APIRouter
from sqlalchemy import text

from app.deps import DbSession
from app.schemas.health import HealthRead

router = APIRouter(prefix="/health", tags=["health"])


def _version() -> str:
    try:
        return version("plutus-api")
    except PackageNotFoundError:
        return "0.1.0"


@router.get("", response_model=HealthRead)
def get_health(db: DbSession) -> HealthRead:
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        return HealthRead(status="degraded", database="unreachable", version=_version())
    return HealthRead(status="ok", database="ok", version=_version())
