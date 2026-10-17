"""Print the Python LLM prompts as JSON for the parity harness's prompt check.

Reads the samples from stdin (tools/parity/prompts.ts pythonSamples()) and renders the system
prompts and user messages with api/app/providers/llm/prompts.py. Run from api/ with
PYTHONPATH=api so `app` imports; prompts.ts does this.
"""

import json
import sys
from decimal import Decimal

from app.models.base import Essentiality
from app.providers.llm import prompts
from app.providers.llm.base import CategorySpend, MerchantInput, RecurringSpend, SavingsContext


def main() -> None:
    samples = json.load(sys.stdin)
    merchants = [MerchantInput(**m) for m in samples["merchants"]]
    s = samples["savings"]
    context = SavingsContext(
        goal_target=Decimal(s["goal_target"]),
        months_left=s["months_left"],
        monthly_gap=Decimal(s["monthly_gap"]),
        categories=[
            CategorySpend(c["label"], [Decimal(t) for t in c["monthly_totals"]])
            for c in s["categories"]
        ],
        recurring=[
            RecurringSpend(
                r["category_label"],
                Decimal(r["amount"]),
                r["cadence"],
                Essentiality(r["essentiality"]),
            )
            for r in s["recurring"]
        ],
        excluded_suggestions=list(s["excluded_suggestions"]),
    )
    json.dump(
        {
            "classify_system_prompt": prompts.classify_system_prompt(),
            "savings_system_prompt": prompts.savings_system_prompt(),
            "classify_user_message": prompts.classify_user_message(merchants),
            "savings_user_message": prompts.savings_user_message(context),
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
