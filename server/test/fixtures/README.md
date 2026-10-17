# Test fixtures

All data here is fake. Never commit real bank data.

- `simplefin_accounts.json` is a SimpleFIN `GET /accounts` response for about 210 days across a checking account, a credit card, and a savings account. It includes biweekly payroll, rent paid by Zelle to a person, card payments and savings transfers that should pair up as internal transfers, monthly subscriptions for recurring detection, everyday variable spending, and one pending transaction (`posted: 0`).
- `scrub_golden.json` defines what `services/scrub.py` must produce. For each raw description, the normalized merchant key must equal `expected_key` when it is not null, and must never contain any string in `must_not_contain`. In addition, every key must have no digit run longer than 3 characters and none of the owner name tokens.
- The fake owner is "ALEX SAMPLE". Tests set `OWNER_NAME_TOKENS=["ALEX","SAMPLE"]`.
- `plaid_pfc_v2.csv` is a copy of `api/app/seed/plaid_pfc_v2.csv`, the source the Python category seed migration reads. `test/db.test.ts` checks `src/db/migrations/seed/categories.json` against it.
- `fastapi-openapi.json` is FastAPI's committed `web/src/api/openapi.json` from before brief 0B regenerated it from the server. `test/contract.test.ts` checks the server's contract against it; it is the frozen oracle and is never regenerated.
- `llm_prompts.json`: a snapshot of the Python prompt builders, output schemas, and rounding cases (brief 1D). The parity harness checks the live prompt text; this fixture keeps the TypeScript tests independent of `api/`.
