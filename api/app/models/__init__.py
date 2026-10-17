"""Import every model so Alembic autogenerate sees the full metadata."""

from app.models.account import Account, BalanceSnapshot
from app.models.base import Base
from app.models.category import Category, MerchantClassification, Rule
from app.models.planning import Goal, ManualEntry, RecurringCharge, Suggestion
from app.models.system import AppSetting, ChangeDismissal, SyncRun
from app.models.transaction import Categorization, Transaction

__all__ = [
    "Account",
    "AppSetting",
    "BalanceSnapshot",
    "Base",
    "Categorization",
    "Category",
    "ChangeDismissal",
    "Goal",
    "ManualEntry",
    "MerchantClassification",
    "RecurringCharge",
    "Rule",
    "Suggestion",
    "SyncRun",
    "Transaction",
]
