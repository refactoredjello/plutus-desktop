# Parity run and Electron audit (brief 4A)

The result of brief 4A in DESKTOP_PLAN.md, for Fable checkpoint B. Branch `port/4a-parity`.
Reproduce with `make parity-self`, `make parity` (writes `tools/parity/report.md`), and
`node_modules/.bin/tsx tools/parity/visual/audit.ts` after `npm run build:all --prefix desktop`
(writes `tools/parity/visual/out/`). Fake demo data only.

Run conditions: `PLUTUS_TODAY=2026-09-30`, `LLM_PROVIDER=fake`,
`OWNER_NAME_TOKENS=["ALEX","SAMPLE"]`, scheduler off, throwaway Postgres `plutus_parity`, temp
SQLite file. Self-check (Python against Python): **0 of 41 endpoints differ, 394 cases**.
Python against TypeScript: **15 of 41 endpoints differ, 0 setup or prompt checks differ, 394
cases** (111 GET cases, 101 write steps with their re-reads). The 15 differing endpoints come
down to four port bugs and one Python bug, listed below. All four prompts are byte-identical.

**Rerun after the fixes (cdc39f1):** Python against TypeScript, **4 of 41 endpoints differ, 0
checks differ, 394 cases**: steps 46 and 47 (backlog 34), step 48 and the manual-entry and
projection re-reads after it (exponent strings), and step 66 (405). All are on the accepted list.
Electron audit: 11 routes, 35 requests, 0 problems (the CSP warning is gone), 0 coverage gaps.

## Coverage

Every operation in `server/test/fixtures/fastapi-openapi.json` (42), plus the two
TypeScript-only config operations. "Statuses" are the statuses Python answered across the
harness cases (the summary column in `report.md`); the TypeScript side is compared on each.

| Operation | Exercised | Cases | Statuses | Notes |
|---|---|---|---|---|
| `GET /api/accounts` | yes | 5 | 200 | re-read after syncs |
| `POST /api/auth/login` | no | - | - | Python-only 501 stub; the desktop contract (0B) drops auth |
| `POST /api/auth/logout` | no | - | - | same |
| `GET /api/auth/session` | no | - | - | same |
| `GET /api/categories` | yes | 18 | 200, 422 | |
| `POST /api/categories` | yes | 5 | 201, 400, 409, 422 | duplicate, no letters, invalid, no body |
| `PATCH /api/categories/{category_id}` | yes | 6 | 200, 404, 422 | |
| `GET /api/goals` | yes | 8 | 200 | |
| `POST /api/goals` | yes | 5 | 201, 400, 422 | |
| `GET /api/goals/{goal_id}` | yes | 6 | 200, 404, 422 | |
| `PATCH /api/goals/{goal_id}` | yes | 6 | 200, 400, 404, 422 | |
| `GET /api/goals/{goal_id}/suggestions` | yes | 6 | 200, 404, 422 | |
| `POST /api/goals/{goal_id}/suggestions` | yes | 3 | 201, 404 | |
| `GET /api/health` | yes | 1 | 200 | |
| `GET /api/manual-entries` | yes | 17 | 200 | |
| `POST /api/manual-entries` | yes | 12 | 201, 400, 422 | numbers, sub-cent, exponent, NaN |
| `DELETE /api/manual-entries/{entry_id}` | yes | 2 | 204, 404 | |
| `PATCH /api/manual-entries/{entry_id}` | yes | 6 | 200, 400, 404, 422 | |
| `GET /api/projection` | yes | 34 | 200, 422 | |
| `GET /api/recurring` | yes | 18 | 200, 422 | |
| `POST /api/recurring` | yes | 6 | 201, 400, 404, 422 | 400 "no merchant yet" unreachable, see below |
| `PATCH /api/recurring/{recurring_id}` | yes | 6 | 200, 404, 422 | |
| `GET /api/reports/balances` | yes | 10 | 200, 422 | |
| `GET /api/reports/by-category` | yes | 19 | 200, 400, 422 | |
| `GET /api/reports/changes` | yes | 19 | 200, 422 | |
| `POST /api/reports/changes/dismiss` | yes | 4 | 204, 422 | |
| `DELETE /api/reports/changes/dismissals` | yes | 1 | 204 | |
| `GET /api/reports/month/{month}` | yes | 14 | 200, 400, 422 | |
| `GET /api/reports/monthly` | yes | 12 | 200, 422 | |
| `GET /api/rules` | yes | 5 | 200 | |
| `DELETE /api/rules/{rule_id}` | yes | 2 | 204, 404 | |
| `GET /api/settings/llm` | yes | 1 | 200 | |
| `DELETE /api/settings/simplefin` | yes | 2 | 204 | |
| `GET /api/settings/simplefin` | yes | 11 | 200 | 400 after a key change: see below |
| `POST /api/settings/simplefin` | yes | 8 | 200, 422, 502 | against a fake bridge on loopback, every claim failure |
| `PATCH /api/suggestions/{suggestion_id}` | yes | 5 | 200, 404, 422 | |
| `POST /api/sync` | yes | 8 | 202, 400, 409 | every bridge mode, conflict, daily budget |
| `GET /api/sync/runs` | yes | 13 | 200, 422 | |
| `GET /api/sync/runs/{run_id}` | yes | 3 | 200, 404, 422 | |
| `GET /api/sync/schedule` | yes | 1 | 200 | |
| `GET /api/transactions` | yes | 71 | 200, 422 | |
| `PATCH /api/transactions/{transaction_id}` | yes | 13 | 200, 400, 404, 422 | |
| `GET /api/settings/config` (TS only) | checked | 1 | - | no Python answer; compared with the env and Python's LLM and schedule answers (setup check, same) |
| `PUT /api/settings/config` (TS only) | no | - | - | no Python counterpart; unit-tested in `server/`; the Settings card sends it only on save |

Also compared: an unknown `/api` path (404) and a method an endpoint lacks (`PUT /api/goals`).

Not exercisable, with the reason (also in `report.md`):

- Live SimpleFIN claim and sync: network, one claim per token. A fake bridge (`bridge.ts`)
  answers claims and account fetches; its request log is compared too (same 20 requests).
- `POST /api/recurring` 400 "no merchant yet": every stored transaction gets a merchant key
  ("UNKNOWN" at worst) in the run that stores it.
- `PATCH /api/transactions/{id}` on an uncategorized transaction: the fake LLM never leaves one
  (backlog 20); unit-tested.
- `GET /api/settings/simplefin` 400 after a secret-key change: needs a restart with another key
  (backlog 13); unit-tested.
- Stale sync-run recovery (30 minutes) and scheduled syncs (scheduler off): unit-tested.

## Differences by class

Each remaining difference in `report.md`, grouped by cause. Cascades are re-reads of an
earlier difference and add nothing new.

| Difference | Cases | Class | Reason |
|---|---|---|---|
| Step 33 `PATCH /api/transactions/295`, no body: 422 vs 500 | 1 | port bug | missing body parsed as `{}`, then the route re-reads it and throws |
| Steps 78, 79, 82, 84: `PATCH` categories, goals, manual entries, recurring with no body: 422 vs 200 | 4 | port bug | missing body validated as `{}`, so an all-optional PATCH succeeds as a no-op |
| Steps 65, 77, 80, 81, 83, 85, 86: `POST` goals, categories, manual entries, recurring, dismiss, simplefin and `PATCH` suggestions with no body: both 422, fields `["body"]` vs each required field | 7 | port bug | same cause; FastAPI reports the missing body itself. Fixed by the same change, so not accepted |
| Step 48 `POST /api/manual-entries` `amount: "1e2"`: 201 `"100.00"` vs 422 | 1 | port bug | Pydantic's Decimal accepts exponent strings at runtime; `MoneyInput` uses FastAPI's documented pattern |
| Re-reads of `GET /api/manual-entries` and `GET /api/projection` after step 48 | 14 | port bug (cascade) | the entry step 48 created exists only in Python |
| Step 66 `PUT /api/goals`: 405 `Method Not Allowed` vs 404 `Not Found` | 1 | port bug | Hono answers 404 for a known path with an unknown method |
| Step 46 `amount: "12.345"`: response `"12.34"` vs `"12.35"` | 1 | Python bug (backlog 34) | Python answers its unrounded request value half-even; both store 12.35 and every later read agrees |
| Step 47 `amount: "-0.005"`: response `"-0.00"` vs `"-0.01"` | 1 | Python bug (backlog 34) | same; both store -0.01 |

Known caveats, unchanged: Python sync uses `datetime.now` for its window (the bridge steps pin
both apps' fetch windows and the bridge log shows they match); ties in `/reports/changes` (none
showed in this run); JSON numbers compare numerically; backlog 11 (the port rejects NaN amounts:
both answered 422 for `"NaN"` in step 49).

## Fix list by brief

Nothing here is fixed on this branch; each item goes to the owning agent.

Outcome: orchestrator item 1 and the desktop CSP item are fixed in cdc39f1; the 2A item became
unreachable with item 1; orchestrator items 2 and 3 are accepted (see the accepted list).

### Orchestrator (app.ts, schemas, routes/openapi.ts)

1. **A missing JSON body is treated as `{}`.** With no body and no `Content-Type`, the Hono
   json validator hands `{}` to Zod. FastAPI answers 422 with `loc: ["body"]`, "Field
   required", before the handler runs, for every operation whose body is required (all of them).
   - Cases: steps 33, 65, 77 to 86 (12 operations).
   - Expected (Python): `422 {"detail":[{"type":"missing","loc":["body"],"msg":"Field required",...}]}`.
   - Actual: `PATCH /api/categories/128` (and goals, manual entries, recurring) `200` with the
     unchanged row; `POST /api/goals` `422` naming `body.name`, `body.target_amount`,
     `body.target_date`; `PATCH /api/transactions/295` `500 text/plain "Internal Server Error"`.
   - Suspected: `server/src/routes/openapi.ts` `jsonBody` (marked `required: true`, which
     @hono/zod-openapi does not enforce for a missing Content-Type) and the body handling in
     `server/src/app.ts` from 3795b47. A 422 with detail `body: Field required` in the
     problem+json shape is what the accepted 422 class expects (`body`).
2. **`MoneyInput` rejects exponent strings.** `"1e2"` is 100.00 to Pydantic; the port answers
   422.
   - Case: step 48 (and its 14 re-reads).
   - Expected: `201 {"amount":"100.00",...}`. Actual: `422`, failing field `body.amount`.
   - Suspected: `server/src/schemas/common.ts` `DECIMAL_STRING` (3795b47 chose FastAPI's
     documented pattern, which excludes exponents; Pydantic's runtime accepts them). JSON numbers
     in exponent form (`1e-7`) are worth checking at the same time.
3. **Wrong method answers 404, not 405.**
   - Case: step 66 `PUT /api/goals`.
   - Expected: `405 {"detail":"Method Not Allowed"}`. Actual: `404 {"detail":"Not Found"}`.
   - Suspected: `server/src/app.ts` not-found handling. Low priority: the frontend never sends it.

### 2A (categorize, rules, transactions)

4. **`PATCH /api/transactions/{id}` reads the body a second time without a guard.**
   `routes/transactions.ts` line 68 calls `c.req.json()` for the sent keys; with no body it
   throws `SyntaxError: Unexpected end of JSON input` and the request answers 500. Item 1 makes
   this unreachable, but the route should take the keys from the validated body rather than
   parsing again. Case: step 33.

### Desktop (1F/5B shell)

5. **No Content-Security-Policy.** Every full page load in the Electron app logs "Electron
   Security Warning (Insecure Content-Security-Policy): This renderer process has either no
   Content Security Policy set or a policy with "unsafe-eval" enabled". Neither the server's SPA
   responses nor the shell set one (no `Content-Security-Policy` anywhere in `server/src`,
   `desktop/src`, or `web/index.html`). The warning disappears when packaged, but the missing
   policy does not.
   - Expected: a CSP on the HTML (for example `default-src 'self'; img-src 'self' data:;
     style-src 'self' 'unsafe-inline'`, checked against what the built SPA needs) and no warning.
   - Suspected: `desktop/src/main.ts` (`session.webRequest.onHeadersReceived`) or the static
     handler in `server/src/app.ts` (orchestrator) if the headless server should send it too.
   - Seen on `/` and on the direct load of `/month/2026-08`.

1B, 1C, 1D, 1E, 2B, 3A, 3B: empty.

## Accepted list (for Fable checkpoint B)

Implemented as named reductions; nothing else is normalized away.

1. **422 validation body shape** (plan 5.5): FastAPI `application/json {"detail":[...]}`
   against the port's `application/problem+json` with a `detail` string. Both are reduced to the
   sorted failing fields (`body.name`, `query.months`; a key Zod names in
   `Unrecognized key: "colour"` counts as `body.colour`); status and fields are still compared,
   messages are not (`accepted.ts`).
2. **Content-Type on an empty 204**: FastAPI sends `application/json`, the port none (RFC 9110).
   Dropped on both sides for an empty 204 only.
3. **Audit only: Chromium's cache-only web font probe.** Chromium first asks the HTTP cache alone
   for a web font and fails with `net::ERR_CACHE_MISS` when it is not there, then fetches it. The
   audit lists the request but does not count it when the same URL then loads in the same route
   (`audit_lib.ts`). The page never sees it: no console message.

Standing normalization rules (timestamps as instants to the second, wall-clock fields masked,
key order ignored, the two `category_totals` tie rules) are listed in every `report.md`.

Owner decisions after the run (2026-10-17), listed but not normalized, so they stay visible in
`report.md`:

4. **Exponent money strings are rejected** (`"1e2"`; step 48 and the 14 re-reads of manual
   entries and the projection that follow it). Pydantic accepted them; the port keeps
   `MoneyInput`'s stricter pattern on purpose (3795b47). The frontend never sends one.
5. **A wrong method answers 404, not 405** (step 66, `PUT /api/goals`). Hono's default; nothing
   in the app sends a wrong method.
6. **Backlog 34** (steps 46 and 47): the port answers the stored, rounded amount where Python
   answered the unrounded request value. The Python bug stays on the backlog under its
   ask-first rule.

Fixed after the run (cdc39f1): a missing required body is 422 at `body` (orchestrator item 1,
which also made the 2A re-parse unreachable, so 2A needs no change), and the SPA HTML carries a
Content-Security-Policy set by the server (desktop item).

## Electron audit by route

The built desktop app (`desktop/dist/main.js` unchanged), cookie guard on, a fresh temp data
dir with the TS demo data (295 transactions), the real clock (2026-10-17, so October has no
transactions yet). After the first page the audit seeds a goal (with suggestions), a planned
item, and a confirmed recurrence through the page's own fetch (201, 201, 201, 200). Unguarded
`GET /api/health` from outside the page: 401.

Run result: 11 log sections (10 routes and the seed), 35 requests, 2 problems (the CSP warning,
twice), 0 coverage gaps, 10 screenshots. Every `/api` request answered 200 with
`application/json`; no failed or blocked request, no console error, no page error.

| Route | Reached by | Requests (status 200 unless noted) | Console / failures | Screenshot |
|---|---|---|---|---|
| `/` | startup | `/` (text/html), JS, CSS, Geist font (cache probe, then 200 font/woff2), `reports/changes`, `reports/monthly?months=12`, `projection?months=3`, `reports/by-category?month=2026-10`, `reports/balances?start=2026-07-19&end=2026-10-17`, `transactions?needs_review=true&limit=1&offset=0` | CSP warning (fix 5) | fine: cards, 12-month chart with data through September, "103 transactions need review" |
| seed | page fetch | `POST goals` 201, `POST goals/1/suggestions` 201, `POST manual-entries` 201, `GET recurring?status=proposed`, `PATCH recurring/2` | none | - |
| `/month` | link | `reports/month/2026-10` | none | fine: "No transactions in October 2026 yet" (real empty month) |
| `/month/2026-08` | direct load (deep link) | `/month/2026-08` (text/html), `reports/month/2026-08`, `transactions?needs_review=true&limit=1&offset=0`, `categories?include_hidden=true` | CSP warning (fix 5) | fine: August totals, essentiality bar, categories |
| `/transactions` | link | `accounts`, `transactions?limit=50&offset=0` | none | fine. Cosmetic: the category select truncates "Other general merchandise" |
| `/review` | link | `transactions?needs_review=true&limit=50&offset=0` | none | fine, same truncation |
| `/spending` | History API (no link on Overview in an empty month) | `reports/by-category?month=2026-10&essentiality=discretionary` | none | fine: empty-bucket message |
| `/recurring` | link | `recurring` | none | fine: proposals and the confirmed one |
| `/goals` | link | `goals`, `goals/1/suggestions` | none | fine: goal card with a suggestion |
| `/planned` | link | `manual-entries` | none | fine |
| `/settings` | link | `settings/simplefin`, `sync/runs?limit=20`, `sync/schedule`, `settings/llm`, `settings/config`, `rules` | none | fine: sync history, accounts, model |

No screenshot showed an empty chart, an error state, missing fonts, or an unstyled page.

Gaps found and closed (red, then green, and in the parity run above):

- `GET /api/transactions?limit,needs_review,offset` (the review badge and the Review page): two
  GET cases, `?needs_review=true&limit=1&offset=0` and `?needs_review=true&limit=50&offset=0`;
  both match.
- `GET /api/settings/config` (Settings): TypeScript only, so a setup check against the env both
  apps got and Python's `/api/settings/llm` and `/api/sync/schedule`; it matches.

## Open questions (answered)

The owner answered these on 2026-10-17:

1. Exponent money strings: keep rejecting them; accepted list item 4.
2. 405 against 404: accepted; item 5.
3. Backlog 34: accepted at checkpoint B; item 6.
4. CSP: in the server's SPA responses (`app.ts`), so the Electron window and the headless
   server both get it; done in cdc39f1.
5. Audit clock: keep the real clock.
6. Incident: the orchestrator checked `~/Library/Application Support/Plutus Dev` read-only. The
   20:59 modification is the owner's own demo load (sync run 1 at 00:59 UTC); there are no
   goals, planned items, or other leftovers, so the probe left nothing behind.
