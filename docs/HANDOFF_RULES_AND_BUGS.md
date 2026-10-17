# Plutus — Agent Handoff: Custom Rule Builder & Bug Fixes

Status: Ready for execution (2026-10-17).
Target audience: Orchestrator session (`Opus`) and subagents (`backend-engineer`, `frontend-engineer`) operating under `AGENTS.md` and `docs/AGENT_PLAN.md`.

## 0. Operating Constraints & Repo Conventions

Before writing code, read `AGENTS.md`, `docs/REQUIREMENTS.md`, and `docs/ARCHITECTURE.md`:

1. **Contract-first workflow**: The orchestrator owns `api/app/models/`, `api/alembic/versions/`, `api/app/schemas/`, and `api/app/main.py`. After any schema or route signature change, run `make openapi` so `web/src/api/openapi.json` and `web/src/api/schema.d.ts` stay in sync (CI fails if stale).
2. **No new dependencies**: Everything needed—including `argon2-cffi` and `itsdangerous` in `api/pyproject.toml`—is already installed.
3. **Single source of truth for financial math**: Never re-derive income, expense, transfer, or essentiality logic outside `api/app/services/aggregates.py`.
4. **Privacy boundary (enforced by tests)**: Only `api/app/services/scrub.py` and `api/app/services/suggestions.py` may build LLM payloads. Rules (`exact`, `contains`, `prefix`) evaluate locally and never leave the machine.
5. **Verification gate**: Every brief is done only when `make check` (`ruff`, `mypy`, `pytest` against `plutus_test`, `tsc`, `eslint`, `vitest`) passes cleanly.

---

## 1. Feature & Bug Brief: Custom Rule Builder & Rule Pipeline Fixes (R2.3, R3.3)

### Problem Summary

1. **Rule deletion leaves stale cache entries (`api/app/services/categories.py`, `api/app/services/transactions.py`)**:
   - `_save_rule()` in `api/app/services/transactions.py` writes a `MerchantClassification` row (`source=ClassificationSource.MANUAL`, `confidence=Confidence.VERY_HIGH`) alongside the `Rule` row.
   - `delete_rule()` in `api/app/services/categories.py` deletes only the `Rule` row. On subsequent syncs, `categorize_pending()` in `api/app/services/categorize.py` hits the surviving `MerchantClassification` cache row and continues assigning the deleted rule's category.
2. **Broken `CONTAINS` and `PREFIX` rule creation (`api/app/services/transactions.py`)**:
   - `_override_category()` always passes `key = tx.merchant_key or scrub_merchant_key(...)` as `Rule.pattern`.
   - For `RuleMatchType.CONTAINS`, `_Rules.match()` and `apply_rule()` in `api/app/services/categorize.py` match against `Transaction.raw_description`, where `merchant_key` may have stripped the target substring (e.g., a memo, location, or counterparty).
   - Furthermore, `_save_rule()` unconditionally writes `MerchantClassification(merchant_key=key)` even when `match_type` is `CONTAINS` or `PREFIX`, polluting the exact-match merchant cache with substring/prefix patterns.
3. **Missing standalone Rule Builder & match-type controls in UI (`web/src/features/settings/RulesCard.tsx`, `web/src/features/transactions/TransactionRow.tsx`)**:
   - `api/app/routers/categories.py` exposes only `GET /api/rules` and `DELETE /api/rules/{rule_id}` (no `POST /api/rules`).
   - `RulesCard.tsx` only lists and deletes existing rules.
   - `TransactionRow.tsx` hardcodes `{ category_id: promptCategory, save_as_rule: true }` without exposing `rule_match_type` or custom pattern editing.

### Step 1 — Orchestrator: Schema & Route Contract Changes

- **`api/app/schemas/categories.py`**:
  - Add `RuleCreate(Schema)`:
    ```python
    class RuleCreate(Schema):
        match_type: RuleMatchType = RuleMatchType.EXACT
        pattern: str = Field(min_length=1, max_length=200)
        category_id: int
        essentiality: Essentiality | None = None
    ```
- **`api/app/schemas/transactions.py`**:
  - Add optional `rule_pattern` to `TransactionUpdate`:
    ```python
    rule_pattern: str | None = Field(default=None, min_length=1, max_length=200)
    ```
- **`api/app/routers/categories.py`**:
  - Add `@router.post("/rules", response_model=RuleRead, status_code=status.HTTP_201_CREATED)` calling `service.create_rule(db, body)`.
- Regenerate client: Run `make openapi`.

### Step 2 — `backend-engineer`: Rule Service & Cache Hygiene

- **Files owned**: `api/app/services/categories.py`, `api/app/services/transactions.py`, `api/app/routers/categories.py`, `api/tests/test_categorize.py` (or `api/tests/test_transactions.py`).
- **Implementation tasks**:
  1. **Pattern normalization & validation (`services/categories.py` & `services/transactions.py`)**:
     - Validate that `category_id` exists in `categories` (raise `DomainError` if missing).
     - Strip whitespace from `pattern`; raise `DomainError` if empty.
     - For `RuleMatchType.EXACT` and `RuleMatchType.PREFIX`, normalize `pattern = pattern.upper()` so it matches scrubbed `merchant_key` values in `services/categorize.py`. For `RuleMatchType.CONTAINS`, preserve case-insensitive matching against `raw_description`.
  2. **Upsert & retroactive application (`create_rule` in `services/categories.py`)**:
     - Upsert `Rule` by `(match_type, pattern)` (updating `category_id` and `essentiality` if an identical `(match_type, pattern)` already exists, matching `_save_rule()` idempotency).
     - Only upsert `MerchantClassification` (`source=ClassificationSource.MANUAL`, `confidence=Confidence.VERY_HIGH`) when `match_type is RuleMatchType.EXACT`. Never insert `CONTAINS` or `PREFIX` patterns into `merchant_classifications`.
     - Call `apply_rule(db, rule)` and `db.commit()`, returning the `Rule`.
  3. **Fix `_override_category()` (`services/transactions.py`)**:
     - When `body.save_as_rule` is `True`:
       - Determine `pattern`: if `body.rule_pattern` is provided and non-empty, use it; otherwise if `body.rule_match_type is RuleMatchType.CONTAINS`, default to `tx.payee or tx.raw_description`; otherwise default to `tx.merchant_key or scrub_merchant_key(tx.raw_description, settings.owner_name_tokens)`.
       - Delegate to the shared rule-saving helper so `EXACT` vs `CONTAINS`/`PREFIX` cache hygiene is enforced in one place.
  4. **Fix `delete_rule()` cache cleanup (`services/categories.py`)**:
     - Before deleting `rule`, clean up stale `MerchantClassification` rows:
       - If `rule.match_type is RuleMatchType.EXACT`, delete any `MerchantClassification` where `merchant_key == rule.pattern` and `source == ClassificationSource.MANUAL`.
       - If `rule.match_type is RuleMatchType.PREFIX`, delete any `MerchantClassification` where `merchant_key.startswith(rule.pattern)` and `source == ClassificationSource.MANUAL`.
       - If `rule.match_type is RuleMatchType.CONTAINS`, delete `MerchantClassification` rows with `source == ClassificationSource.MANUAL` for `merchant_key`s belonging to transactions whose `raw_description` matches `rule.pattern`.

### Step 3 — `frontend-engineer`: Custom Rule Builder UI & Inline Rule Options

- **Files owned**: `web/src/features/settings/RulesCard.tsx`, `web/src/features/transactions/TransactionRow.tsx`, `web/src/mocks/handlers.ts`, and corresponding frontend tests.
- **Implementation tasks**:
  1. **`RulesCard.tsx` ("New rule" Dialog)**:
     - Add a primary `New rule` button in `CardHeader` opening a `Dialog`.
     - Form controls:
       - **Match type**: Select between `exact` ("Merchant is"), `prefix` ("Merchant starts with"), and `contains` ("Bank description contains").
       - **Pattern**: Text input (`placeholder` adapts to match type, e.g. `TRADER JOE S` for exact/prefix vs `VENMO*JANE` for contains).
       - **Category**: `CategorySelect` (required).
       - **Essentiality**: `EssentialitySelect` (optional; defaults to unset/keep existing).
     - Submit calls `api.POST('/api/rules', { body })`, closes the dialog, and invalidates `['rules']`, `['transactions']`, and `['reports']` query keys.
     - Update `useDeleteRule()` `onSuccess` to also invalidate `['transactions']`.
  2. **`TransactionRow.tsx` (Inline "Apply to all" enhancement)**:
     - When the `"Apply to all from ...?"` prompt appears after a category change, allow toggling between:
       - Exact merchant match (`rule_match_type: 'exact'`, `rule_pattern: tx.merchant_key`)
       - Contains / prefix match with an editable pattern input pre-filled with `tx.merchant_key ?? tx.payee ?? tx.raw_description`.
  3. **MSW Mocks & Tests**:
     - Add `http.post('/api/rules', ...)` handler in `web/src/mocks/handlers.ts`.
     - Add Vitest coverage for creating a custom rule in `RulesCard` and deleting a rule.

---

## 2. Bug Fixes Backlog & Implementation Specs

Each bug below is scoped with exact files, root cause, and required fix so it can be assigned as a standalone brief or bundled by area.

### Bug 1 — False-Positive Internal Transfer Matching (R2.4)
- **Files**: `api/app/services/transfers.py`, `api/tests/test_transfers.py` (or `test_categorize.py`)
- **Root cause**: `match_transfers()` pairs *any* two non-pending transactions across different accounts within `WINDOW = timedelta(days=5)` that have equal `abs(amount)` and opposite signs—without checking whether either transaction looks like a transfer or credit card payment. A $45.00 refund on Credit Card A and an unrelated $45.00 restaurant charge on Credit Card B within 5 days are permanently paired (`is_transfer=True`) and hidden from spending.
- **Fix**:
  1. Load `Account.type` for all accounts involved.
  2. Require at least one of the following transfer signals before pairing `out` (outflow) and `inc` (inflow):
     - At least one side's `raw_description` or `payee` matches transfer/payment keywords (reuse ` MONEY_MOVEMENT_PATTERNS` / `_TRANSFER_WORDS` from `services/scrub.py` or a shared constant: `TRANSFER`, `XFER`, `PAYMENT`, `PYMT`, `AUTOPAY`, `ONLINE PMT`, `THANK YOU`, `ACH`, `ZELLE`), **OR**
     - One account is `checking`/`savings` and the other is `credit`/`loan` (a bank-to-card/loan payment), **OR**
     - Both accounts are depository (`checking`/`savings`) and neither transaction is on a `credit` card as an ordinary purchase.
  3. Never pair two `AccountType.CREDIT` transactions unless at least one description explicitly contains a payment/transfer keyword.
  4. Optional UI recovery: In `services/transactions.py` (`TransactionUpdate`), support `is_transfer: bool | None = None` so unchecking transfer status on one transaction clears `is_transfer` and `transfer_pair_id` on both paired rows.

### Bug 2 — Stale `next_expected_date` When Updating Recurrence Cadence (R6.3, R7.1)
- **Files**: `api/app/services/recurring.py`, `api/tests/test_recurring.py`
- **Root cause**: In `update_recurring()` (`api/app/services/recurring.py:219-231`), when `changes.get("cadence") is not None`, it computes:
  ```python
  charge.next_expected_date = next_after(
      charge.last_seen_on or charge.next_expected_date, charge.cadence
  )
  ```
  Unlike `mark_recurring()` (lines 189–191), it only steps forward **once** from `last_seen_on` instead of advancing until `> schedule.today()` when appropriate, which can leave `next_expected_date` in the past or misalign projections in `services/projection.py`.
- **Fix**:
  - When recomputing `next_expected_date` in `update_recurring()`, step forward from `charge.last_seen_on` (if present):
    ```python
    anchor = charge.last_seen_on or charge.next_expected_date
    nxt = next_after(anchor, charge.cadence)
    while nxt <= schedule.today():
        nxt = next_after(nxt, charge.cadence)
    charge.next_expected_date = nxt
    ```
  - Add a unit test in `api/tests/test_recurring.py` verifying that updating a cadence on a charge whose `last_seen_on` is more than one new cadence period ago advances `next_expected_date` past `schedule.today()`.

### Bug 3 — Sync Concurrency Race Condition (R1.2, R1.3)
- **Files**: `api/alembic/versions/` (new migration via orchestrator), `api/app/models/sync.py`, `api/app/services/sync.py`, `api/tests/test_sync.py`
- **Root cause**: `start_run()` in `api/app/services/sync.py:72-92` checks `select(SyncRun.id).where(SyncRun.status == SyncStatus.RUNNING)` in Python before inserting a new `RUNNING` row. If the APScheduler job (`api/app/scheduler.py`) and a manual `POST /api/sync` request arrive concurrently, both transactions can pass the `SELECT` check and run parallel SimpleFIN fetches, double-spending the 24-request daily budget.
- **Fix**:
  1. Add a partial unique index on `sync_runs(status) WHERE status = 'running'` in an Alembic migration (and `Index("ix_sync_runs_single_running", SyncRun.status, unique=True, postgresql_where=(SyncRun.status == SyncStatus.RUNNING))` on `SyncRun`).
  2. In `start_run()` (`api/app/services/sync.py`), catch `sqlalchemy.exc.IntegrityError` on `db.commit()`, roll back, and raise `ConflictError("A sync is already running.")`.

### Bug 4 — Balance History Reconstruction Includes Pending Transactions & Pre-Creation Dates (R4.3)
- **Files**: `api/app/services/reports.py`, `api/tests/test_reports.py`
- **Root cause**: `balance_history()` in `api/app/services/reports.py:61-106` rebuilds daily balances backward from the latest `BalanceSnapshot.balance` by subtracting `func.sum(Transaction.amount)` grouped by `posted_on`. It currently:
  1. Includes `pending=True` transactions even though institutional ledger `balance` (as opposed to `available`) typically excludes pending authorizations.
  2. Walks backward all the way to `start` (180 days) even before the account's earliest transaction and earliest snapshot, producing a flat synthetic balance line before the account existed.
- **Fix**:
  1. Filter the transaction sum in `balance_history()` to posted transactions only: `Transaction.pending.is_(False)`.
  2. Clamp each account's earliest point to `min(earliest_tx_date, earliest_snapshot_date)` (when later than `start`) so newly opened accounts do not display a flat 6-month pre-history line.

### Bug 5 — UTC vs. Local Timezone Rollover on Month Boundaries (R4.5, R11.2, R12)
- **Files**: `api/app/config.py`, `api/app/services/schedule.py`, `web/src/lib/dates.ts`, `web/src/features/spending/data.ts`
- **Root cause**: `schedule.today()` in `api/app/services/schedule.py:11-13` returns `datetime.now(UTC).date()`, and the frontend uses `.toISOString().slice(0, 7)` (UTC). On the final evening of any month in US timezones (e.g., 8:00 PM EDT on October 31 = 00:00 UTC on November 1), Plutus flips to the next month early and marks the current month as complete.
- **Fix**:
  1. Add `timezone: str = "America/New_York"` (or `"UTC"` default with `.env` override `TIMEZONE=America/New_York`) to `Settings` in `api/app/config.py`, and use `zoneinfo.ZoneInfo` in `schedule.today()`.
  2. In the frontend (`web/src/lib/dates.ts` and `web/src/features/spending/data.ts`), construct local `YYYY-MM` and `YYYY-MM-DD` strings using local `getFullYear()`, `getMonth() + 1`, and `getDate()` instead of `toISOString()`.

### Bug 6 — Unimplemented Phase 8 Authentication & Route Protection (R9.1–R9.3)
- **Files**: `api/app/routers/auth.py`, `api/app/deps.py`, `api/app/main.py`, `api/app/services/auth.py` (new), `web/src/app/router.tsx`, `web/src/pages/Login.tsx` (new)
- **Root cause**: `api/app/routers/auth.py` raises `NotImplementedYetError` on `/api/auth/login`, `/api/auth/logout`, and `/api/auth/session`, and no route dependency checks session cookies even when `APP_PASSWORD_HASH` is configured.
- **Fix**:
  1. Use the already-installed `argon2-cffi` (`PasswordHasher().verify(...)`) and `itsdangerous` (`TimestampSigner` / `URLSafeTimedSerializer` keyed by `settings.secret_key`) to implement stateless signed `HttpOnly`, `SameSite=Lax` session cookies (`plutus_session`).
  2. If `settings.app_password_hash` is empty (local dev default when unset), treat sessions as authenticated so existing dev workflows and tests without auth configured keep working; when `settings.app_password_hash` is set, enforce a router-level dependency on all routers in `api/app/main.py` except `/api/health` and `/api/auth/*`.
  3. Implement `/api/auth/login`, `/api/auth/logout`, and `/api/auth/session` in `api/app/routers/auth.py`.

---

## 3. Recommended Execution Order (Waves)

1. **Wave A (Orchestrator — Serial, ~15 min)**:
   - Apply schema updates (`RuleCreate`, `TransactionUpdate.rule_pattern`), add `POST /api/rules` route stub in `api/app/routers/categories.py`, create the Alembic migration for `ix_sync_runs_single_running`, and run `make openapi`.
2. **Wave B (Parallel Subagents)**:
   - **`backend-engineer` 1**: Custom Rule Builder service (`create_rule`, `delete_rule` cache cleanup, `_override_category` `CONTAINS`/`PREFIX` fix) + Bug 1 (transfer matching guard).
   - **`backend-engineer` 2**: Bug 2 (`update_recurring` `next_expected_date`), Bug 3 (`start_run` `IntegrityError` handling), Bug 4 (`balance_history` pending filter), and Bug 5 (`schedule.today()` timezone support).
   - **`frontend-engineer`**: `RulesCard.tsx` "New rule" dialog, `TransactionRow.tsx` match-type selector, local date helper fixes, and MSW/Vitest tests.
3. **Wave C (Serial — Phase 8 Auth)**:
   - Implement `services/auth.py`, `routers/auth.py`, route dependency enforcement, and login UI.
4. **Final Gate**:
   - Run `make check` from the repository root and verify zero lint, type, or test failures.
