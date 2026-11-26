# Backlog

Plutus's own list of open bugs and wanted changes. Each entry names the file and the behaviour in today's code. Most bugs are pinned by a test that asserts today's behaviour.

**Rule: nothing on this list is fixed without asking the owner first.** The owner decides which items to fix and when. A fix changes the pinned test on purpose and says so in its commit, and the entry moves to "Fixed".

Numbers are stable: code and tests cite them (for example "backlog 29"). New entries take the next free number.

## Rules and categorization

19. `updateCategory` in `services/categories.ts` strips the label after validation, so a whitespace-only label is stored empty. (`createCategory` rejects it.)

## Recurring charges and schedule

1. Changing a charge's cadence can set its next expected date in the past. `updateRecurring` in `services/recurring.ts` steps once from the last seen date, unlike `markRecurring`, which rolls forward past today. Wanted: keep stepping by the new cadence until the date is after today, with a test for a charge last seen more than one period ago.
2. Semimonthly `nthOccurrence(anchor, n = 0)` in `services/schedule.ts` isn't always the anchor: an anchor on the 28th to 30th of a long month moves to the month's last day. `occurrences` and the projection inherit it.
4. `detectRecurring` never updates a stored charge's cadence, even when the detected cadence differs.

## Scrubbing

6. `STAR_REFERENCE` in `services/scrub.ts` mixes ASCII `[A-Z0-9]` with the Unicode digit class, so a reference with non-ASCII digits is only half removed.
8. An owner token that starts or ends with punctuation can never match the word-boundary pattern in `stripOwnerTokens`; a multi-word token like `MARY (ANN)` is not removed.

## SimpleFIN

9. `inferAccountType` in `providers/bank/simplefin.ts` matches "credit" anywhere in the name, so "Credit Union Checking" becomes a credit account.
12. Malformed bridge data (a missing `id`, a non-object `org`) throws a plain `Error` or `TypeError` in `providers/bank/simplefin.ts` instead of a `ProviderError`, so the failed run's error text reads like `Error("KeyError: 'id'")` rather than a SimpleFIN message.

## Settings

14. A malformed connected-at timestamp makes `simplefinStatus` throw (a 500).

## Planning and reports

22. A goal that is already reached can show "not on track" when recent monthly net is negative: `computeProgress` in `services/goals.ts` compares the recent average with the required monthly saving even when nothing is left to save.
23. Marking one occurrence of a recurring planned entry as paid hides all its future occurrences: `project` in `services/projection.ts` drops every entry with a `fulfilled_transaction_id`.

## What changed

25. `merchantLabel` in `services/changes.ts` orders by `posted_on desc` with no tiebreak, so with two payees on the same day the label is arbitrary.
26. S4 (`s4CategoryAbove`) builds "usual" from the span between the first and last active month, so inactive months in between are included; this matters only when a month's spending nets to zero.
27. S7 (`s7ReviewBacklog`) takes its "biggest" item from at most `REVIEW_SCAN_LIMIT` (500) of the newest review rows, while its total counts every row.

## Sync and scheduler

30. Jitter is added to the previous jittered run time (`server/src/scheduler.ts`), so the schedule drifts by about a minute per interval.

## Closed without a change

Entries that today's code does not have, or that the owner closed, kept so their numbers stay unused.

7. `stripOwnerTokens` in `services/scrub.ts` length-checks owner tokens before upper-casing them, so a short token with a sharp s (U+00DF, which upper-cases to `SS`) is dropped. Dropped by the owner, 2026-10-18: only affects very short names containing a sharp s.
32. A sync commits per step (`runSync` in `services/sync.ts`; better-sqlite3 can't hold a transaction across the LLM call), so a failure after the account and transaction upsert leaves those rows committed rather than rolling the whole run back. Closed by the owner, 2026-10-18: the failure is recorded, upserts don't duplicate, and the next sync categorizes what's left.

10. Claim-URL errors: `claimSetupToken` in `providers/bank/simplefin.ts` turns any failure to reach the claim URL (an invalid IPv6 URL included) into a `ProviderError`, and a non-http(s) access URL fails as `UnsupportedProtocol`.
11. `NaN` and `Infinity` amounts: `decimalToCents` in `providers/bank/simplefin.ts` rejects them as non-numeric.
34. A write's response showing a different amount from the one stored: request money is parsed to cents once (`MoneyInput` in `schemas/common.ts`), and the response formats the stored cents.

## Fixed

13. `simplefinStatus` in `services/app_settings.ts` decrypted the access URL just to check that it exists, so after a secret-key change (or a denied Keychain) `GET /api/settings/simplefin` answered 400 instead of reporting "connected". Fixed 2026-11-26, owner approved: the status checks that a non-empty access URL is stored without decrypting it; a sync still decrypts it and reports an unreadable secret.
29. A scheduled sync that fires more than a second late is skipped and pushed a full interval later (`MISFIRE_GRACE_SECONDS` in `server/src/scheduler.ts`). On a laptop that sleeps this skips due syncs. Fixed 2026-11-25, owner approved: the wait is a chain of timers of at most a minute that check the wall clock; a run up to a minute late runs at once, a later one (a sleep over the due time) runs once two minutes after the scheduler notices, and `GET /api/sync/schedule` never reports a time in the past.
31. The scheduler read its interval and on/off setting once at start, so Settings changes waited for a restart while `GET /api/sync/schedule` showed the stored values. Fixed in aebc9b3, owner approved 2026-10-17: the timer reads the stored config each time it arms, and `PUT /api/settings/config` reschedules.
38. The server's "today" is the UTC date. `today()` in `server/src/lib/dates.ts` rolls over at UTC midnight, so on the last evening of a month in US time zones the server's reports, projection, and "What changed" treat the next month as current and the current one as complete. The web app's helpers (`web/src/lib/dates.ts`) already use local time, so for those hours the two disagree. Wanted: the server's "today" in the machine's local zone (or a time zone setting). Fixed 2026-10-18, owner approved: the server's today is the machine's local date (lib/dates.ts), tests pin TZ.
24. S9 in `services/changes.ts` uses `project`, which reads the real "today", not the `today` passed to `compute`, so computing for another day gives an S9 for the wrong day. Fixed 2026-10-18, owner approved: S9 projects from the day passed to compute.
5. For a charge detection can't confirm (for example a hand-marked yearly fee), the fallback in `detectRecurring` refreshes the dates but not the amount, so a renewal at a new price keeps the old amount. Fixed 2026-10-18, owner approved: a hand-marked charge takes the latest amount when it shows up again.
3. `detectRecurring` in `services/recurring.ts` can count one row as two changes when it refreshes dates and fills essentiality in the same run. Fixed 2026-10-18, owner approved: each recurrence counts once per detection run.
37. Balance history includes pending transactions and invents history. `balanceHistory` in `services/reports.ts` walks back from the latest snapshot by daily sums that include pending transactions (the ledger balance usually excludes them), and draws a flat line back to the start of the window (180 days) even before the account's first transaction or snapshot. Wanted: sum posted transactions only, and start each account's series at its earliest transaction or snapshot when that is later than the window's start. Fixed 2026-10-18, owner approved: balance history sums posted transactions only and starts each account at its first data.
33. The scheduler clamps a zero or negative interval to one second (`clampedInterval` in `server/src/scheduler.ts`). Settings rejects an interval under one hour, but `SYNC_INTERVAL_HOURS` seeds any integer from the environment on first run, so a bad seed syncs every second until the daily request guard refuses. Fixed 2026-10-18, owner approved: SYNC_INTERVAL_HOURS and SYNC_FIRST_HISTORY_DAYS must be integers of at least 1, or startup fails with a ConfigError.
28. S5's "seen before" (`s5NewMerchants`) and S6's "similar before" (`seenSimilarBefore`) count pending and transfer transactions. Fixed 2026-10-18, owner approved: seen before and similar before count only posted, non-transfer rows.
35. Wanted: a rule builder. Today rules are only created from a transaction ("Apply to all from ..."), always as exact rules on the merchant key, and `RulesCard.tsx` can only list and delete them. Wanted: `POST /api/rules` (match type, pattern, category, optional essentiality) that upserts by match type and pattern, applies the rule to existing transactions, and follows the cache rules of items 15 and 16; a "New rule" dialog in `web/src/features/settings/RulesCard.tsx` (exact "Merchant is", prefix "Merchant starts with", contains "Bank description contains"); and in `web/src/features/transactions/TransactionRow.tsx` a choice of match type with an editable pattern when applying a category to all from a merchant. Deleting a rule should also refresh transactions in the UI. Builds on items 15 to 17. Fixed 2026-10-18, owner approved: rule builder: POST /api/rules, a New rule dialog in Settings, and match type plus editable pattern in Apply to all.
15. Deleting a rule leaves its merchant cache entry. `saveRule` in `services/transactions.ts` writes a `merchant_classifications` row (manual, very high confidence) next to the rule, and `deleteRule` in `services/categories.ts` deletes only the rule, so later syncs keep applying the deleted rule's category from the cache. Wanted: when a rule is deleted, remove the manual cache rows it created (the exact key; keys starting with a prefix pattern; keys of transactions a contains pattern matches). Fixed 2026-10-18, owner approved: deleting a rule removes the manual cache rows it created.
16. Saving a prefix or contains rule also writes an exact-match cache entry. `saveRule` in `services/transactions.ts` always upserts `merchant_classifications` for the key, whatever the match type. Wanted: write the cache entry for exact rules only. Fixed 2026-10-18, owner approved: only exact rules write a cache entry.
17. Prefix and contains rules saved from a transaction use the full merchant key as the pattern. `overrideCategory` in `services/transactions.ts` passes the merchant key for every match type, while contains rules match against `raw_description`, where the key may have dropped the text the owner meant. Wanted: an optional `rule_pattern` on the transaction update; without one, a contains rule defaults to the payee or raw description; exact and prefix patterns are upper-cased to match merchant keys. Fixed 2026-10-18, owner approved: optional rule_pattern; a contains rule defaults to the payee when the description contains it, else the description.
18. Contains rules match with full case folding during categorization (`casefold` in `services/categorize.ts`) but with the simple lowercase mapping in `applyRule` (`icontains`/`simpleLower`), so a `STRASSE` rule categorizes a new transaction that spells it with a sharp s (U+00DF) but never re-applies to an existing one. Fixed 2026-10-18, owner approved: contains rules use one case folding when categorizing and in applyRule.
20. Sending a default explicitly (`save_as_rule: false`) makes a note-only edit of an uncategorized transaction fail with 400: `updateTransaction` in `services/transactions.ts` treats every sent key as set. Fixed 2026-10-18, owner approved: save_as_rule: false alone no longer counts as setting rule fields.
36. False-positive transfer pairs. `matchTransfers` in `services/transfers.ts` pairs any two posted transactions in different accounts with equal and opposite amounts at most five days apart, without any transfer signal. A $45.00 refund on one card and an unrelated $45.00 charge on another are paired, marked `is_transfer`, and hidden from spending for good. Wanted: require a signal before pairing (a transfer or payment word such as TRANSFER, XFER, PAYMENT, PYMT, AUTOPAY, ONLINE PMT, THANK YOU, ACH, ZELLE in the description or payee; or a checking or savings account paired with a credit or loan account; or two depository accounts), never pair two credit accounts without a payment word, and optionally let the owner unpair a transfer from the transaction (clearing `is_transfer` and `transfer_pair_id` on both rows). Fixed 2026-10-18, owner approved: pairing needs a transfer signal, a sync only pairs rows new to it, and Unpair (POST /api/transactions/{id}/unpair, a confirm in the transaction row) clears a wrong pair.
21. Minor: `matchTransfers` in `services/transfers.ts` documents a five-day window, while the fixture test asserts pairs at most three days apart. Both hold. Fixed 2026-10-18, owner approved: the 5-day window is tested (4 and 5 days pair, 6 doesn't).
