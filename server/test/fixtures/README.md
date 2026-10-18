# Test fixtures

All data here is fake. Never commit real bank data.

- `simplefin_accounts.json` is a SimpleFIN `GET /accounts` response for about 210 days across a checking account, a credit card, and a savings account. It includes biweekly payroll, rent paid by Zelle to a person, card payments and savings transfers that should pair up as internal transfers, monthly subscriptions for recurring detection, everyday variable spending, and one pending transaction (`posted: 0`).
- `scrub_golden.json` defines what `services/scrub.ts` must produce. For each raw description, the normalized merchant key must equal `expected_key` when it is not null, and must never contain any string in `must_not_contain`. In addition, every key must have no digit run longer than 3 characters and none of the owner name tokens.
- The fake owner is "ALEX SAMPLE". Tests set `OWNER_NAME_TOKENS=["ALEX","SAMPLE"]`.
- `plaid_pfc_v2.csv` is Plaid's personal finance category taxonomy (v2), the source of the category seed. `test/db.test.ts` checks `src/db/migrations/seed/categories.json` against it.
- `llm_prompts.json` is a snapshot of the prompts, the structured-output schemas, and the float-to-cents cases. `test/prompts.test.ts` checks the code against it byte for byte, so a prompt change updates it on purpose.
