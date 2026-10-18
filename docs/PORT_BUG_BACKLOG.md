# Bugs found while porting (backlog)

The desktop port copies the Python app's behaviour exactly, bugs included, so the parity harness can compare the two apps. Agents found these suspected bugs in the Python code along the way. They are ported as they are, with tests that pin today's behaviour.

**Rule: none of these is fixed without asking the owner first.** After cutover (DESKTOP_PLAN.md section 9), the orchestrator brings this list to the owner, and the owner decides which to fix and when. A fix changes the pinned test on purpose and says so in its commit.

Each entry names the brief that found it and where it lives in the TypeScript port.

## Recurring charges and schedule (brief 1B)

1. Changing a charge's cadence can set its next expected date in the past: `update_recurring` recomputes from the last seen date and doesn't roll forward past today, unlike `mark_recurring`. `services/recurring.ts`. (The cadence-change fix in HANDOFF_RULES_AND_BUGS.md.)
2. Semimonthly `nth_occurrence(n=0)` isn't always the anchor: an anchor on the 28th to 30th of a long month moves to the month's last day. `services/schedule.ts`; inherited by `occurrences` and the projection.
3. `detect_recurring` can count one row as two changes when it refreshes dates and fills essentiality in the same run.
4. Detection never updates a stored recurrence's cadence, even when the detected cadence differs.
5. For a charge detection can't confirm (e.g. a hand-marked yearly fee), the fallback refreshes dates but not the amount, so a renewal at a new price keeps the old amount.

## Scrubbing (brief 1A)

6. `_STAR_REFERENCE` mixes ASCII `[A-Z0-9]` with Unicode `\d`, so a reference with non-ASCII digits is half removed.
7. Owner tokens are length-checked before uppercasing, so `ß` (which uppercases to `SS`) is dropped.
8. An owner token that starts or ends with punctuation can never match the word-boundary pattern; a multi-word token like `MARY (ANN)` would not be removed.

## SimpleFIN and providers (brief 1D)

9. `infer_account_type` matches "credit" anywhere in the name, so "Credit Union Checking" becomes a credit account.
10. Some claim-URL errors (an invalid IPv6 URL, httpx `InvalidURL`) surface as 500s instead of a provider error.
11. SimpleFIN amounts of `NaN` or `Infinity` are accepted and would reach the database. (The port rejects them; a parity difference.)
12. Malformed bridge data (a missing `id`, a non-object `org`) raises a plain error (500).

## Settings (brief 1E)

13. `GET /settings/simplefin` decrypts the access URL just to check it exists, so after a secret-key change it answers 400 instead of reporting "connected".
14. A malformed connected-at timestamp gives a 500.

## Categorization, rules, transactions (brief 2A)

15. Deleting a rule leaves its merchant cache entry, so the deleted rule keeps categorizing on later syncs. (In HANDOFF_RULES_AND_BUGS.md.)
16. Saving a prefix or contains rule also writes an exact-match cache entry. (In HANDOFF_RULES_AND_BUGS.md.)
17. Prefix and contains rules saved from a transaction use the full merchant key as the pattern. (In HANDOFF_RULES_AND_BUGS.md.)
18. Contains rules match with `casefold` during categorization but with SQL `lower()` in `apply_rule`, so a `STRASSE` rule categorizes a new "Straße" transaction but never re-applies to an existing one.
19. A whitespace-only category label passes validation and is stored empty after stripping.
20. Sending a default explicitly (`save_as_rule: false`) makes a note-only edit of an uncategorized transaction fail with 400.
21. Minor: the transfer window is documented as five days while the fixture test asserts at most three. Both hold.

## Planning (brief 2B)

22. A goal that is already reached can show "not on track" when recent monthly net is negative.
23. Marking one occurrence of a recurring planned entry as paid hides all its future occurrences from the projection.

## What changed (brief 3B)

24. S9 uses the projection, which reads the real "today", not the `today` passed to `compute`, so computing for another day gives an S9 for the wrong day.
25. `merchant_label` orders by `posted_on desc` with no tiebreak, so with two payees on the same day the label is arbitrary.
26. S4 builds "usual" from the span between the first and last active month, so inactive months in between are included; this matters only when a month's spending nets to zero.
27. S7's "biggest" item is taken from at most 500 of the newest review rows, while its total counts every row.
28. S5's "seen before" and S6's "similar before" count pending and transfer transactions.

## Sync and scheduler (brief 3A)

29. A scheduled sync that fires more than a second late is skipped and pushed a full interval later (APScheduler's default 1 s misfire grace, never overridden). On a laptop that sleeps this skips due syncs.
30. Jitter is added to the previous jittered time, so the schedule drifts by about a minute per interval.

## Parity run (brief 4A)

34. A write's response can show a different amount from the one it stored. The session keeps objects after commit (`expire_on_commit=False`), so the response formats the request's own `Decimal` with `f"{v:.2f}"` (half to even), while `NUMERIC(14,2)` stored it rounded half away from zero. `POST /api/manual-entries` with `"12.345"` answers `"12.34"` and stores 12.35; `"-0.005"` answers `"-0.00"` and stores -0.01. Every request money field is affected (manual entries, goal targets, recurring amounts). The port answers what it stored (parity steps 46 and 47; `schemas/common.ts` `MoneyInput`).

## Port behaviour to revisit (not Python bugs; same ask-first rule)

32. A sync commits per step (better-sqlite3 can't hold a transaction across the LLM call), so a failure after the account and transaction upsert leaves those rows committed where Python rolled the whole run back.
33. The port clamps a zero or negative sync interval to one second; Python's scheduler would loop forever on a negative one.

## Fixed

31. The scheduler reads its interval and on/off setting once at start. The desktop can now change them through Settings, but the running scheduler keeps the old values until the app restarts, while `GET /api/sync/schedule` shows the stored ones. Fixed in aebc9b3 (brief 5D), owner approved 2026-10-17: the timer reads the stored config each time it arms, and `PUT /api/settings/config` reschedules.
