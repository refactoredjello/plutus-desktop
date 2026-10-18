# Test fixtures

All data here is fake. Never commit real bank data.

- `simplefin_accounts.json` is a SimpleFIN `GET /accounts` response for about 210 days across a checking account, a credit card, and a savings account. It includes biweekly payroll, rent paid by Zelle to a person, card payments and savings transfers that should pair up as internal transfers, monthly subscriptions for recurring detection, everyday variable spending, and one pending transaction (`posted: 0`).
- `scrub_golden.json` defines what `services/scrub.ts` must produce. For each raw description, the normalized merchant key must equal `expected_key` when it is not null, and must never contain any string in `must_not_contain`. In addition, every key must have no digit run longer than 3 characters and none of the owner name tokens.
- The fake owner is "ALEX SAMPLE". Tests set `OWNER_NAME_TOKENS=["ALEX","SAMPLE"]`.
- `plaid_pfc_v2.csv` is Plaid's personal finance category taxonomy (v2), the source of the category seed. `test/db.test.ts` checks `src/db/migrations/seed/categories.json` against it.
- `llm_prompts.json`: a snapshot of the prompt builders, output schemas, and rounding cases (brief 1D), frozen from the Python app before it left the repository.
- `demo-export.json` is one export of the demo data made by the Python app's `python -m app.export_json` at tag `wave-4` (the format `scripts/import-json.ts` reads; see docs/MIGRATING_DATA.md), after write steps had filled every table. Its SimpleFIN access URL (`https://demo-user:demo-pass@bridge.invalid/simplefin`) and Anthropic API key (`sk-ant-fake-import-check-not-a-key`) are fake, like everything else in it. `demo-export.expected.json` holds the exported database's row counts, the Python API's `GET /api/reports/monthly` answers on it (`PLUTUS_TODAY=2026-09-30`), and the two secrets; `test/import-fixture.test.ts` imports the file and checks all three.
