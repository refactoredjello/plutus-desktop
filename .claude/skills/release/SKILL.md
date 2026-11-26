---
name: release
description: Cut, ship, or publish a new release (version) of the Plutus desktop app and install it. Use when the owner asks to release, ship, publish, or bump the version of the app, or to put what is on main into the installed app.
---

# Release Plutus

Invoking this skill is the owner's go-ahead to merge the release PR this run opens, and only that one. Everything else in AGENTS.md still holds:

- Never merge any other PR. `npm run release -- merge` refuses anything not titled `desktop: version X.Y.Z`.
- Never pass `--admin`, skip, or rerun a failing check to get past it.
- If a check or the Release workflow fails, stop. Report the failing step and its log (`gh run view <run id> --log-failed`); don't fix it here.

Run the commands in `desktop/`. They never touch the current branch or working tree.

## Steps

1. `npm run release -- changes`. It prints the last tag and the PRs merged since. If it says there is nothing to release, stop and tell the owner.
2. Pick the bump and tell the owner in one line which one and why:
   - `major`: breaks existing data or changes behaviour the owner relies on
   - `minor`: new user-visible features
   - `patch`: fixes only
3. Write a short body file in your scratchpad: one bullet per PR, in plain user-facing words, with its number. Skip CI-only or docs-only changes, or fold them into one line. For example:

   ```
   Minor release with two features since 0.6.1:

   - Recurring page split into Income and Bills; mark a charge as recurring from the transaction panel (#18).
   - Bills whose amount varies are estimated from the same time last year (#19).
   ```

   The script adds the after-merge note and the Claude Code footer.
4. `npm run release -- open <part> --body-file <file>`. Note the PR number and URL it prints.
5. `npm run release -- merge <number>`. Waits for CI (about 5 minutes), then squash-merges.
6. `npm run release -- tag`. Tags the merged commit `v<version>` and pushes only the tag.
7. `npm run release -- wait`. Watches the Release workflow (about 15 minutes) and checks the four files are on the release.
8. From the repo root, run `make update` in the background (it downloads the release). It quits Plutus, installs the release with a data copy and rollback zip, and reopens it. Report its outcome; if it refuses (for example, something holds `plutus.sqlite` open), pass on its message and don't retry with force.

`npm run release -- all <part> --body-file <file>` runs steps 4 to 7 in one go.

## Report

- Version and bump, with the one-line reason
- Release PR URL
- Release URL
- `make update` outcome (installed version, or its error)
