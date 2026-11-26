#!/bin/bash
# Cuts a Plutus desktop release end to end (in desktop/: npm run release -- <command>).
#
#   release.sh changes            print the last v* tag and the changes on origin/main since it
#                                 (exits 1 when there are none)
#   release.sh open <patch|minor|major> [--body-file <file>] [--dry-run]
#                                 bump the version in a temporary worktree of origin/main, push
#                                 branch claude/release-X-Y-Z, open the PR "desktop: version X.Y.Z"
#                                 (--body-file replaces the generated list of changes; the
#                                 after-merge note and footer are always added; --dry-run stops
#                                 before pushing and prints what it would open)
#   release.sh merge <pr>         wait for the checks of a release PR, then squash-merge it
#                                 (refuses any PR not titled "desktop: version X.Y.Z" on main)
#   release.sh tag                tag the commit on origin/main that set the version v<version>
#                                 and push only that tag
#   release.sh wait [<version>]   watch the Release workflow for v<version> (default: the version
#                                 on origin/main) and check the release has its four files
#   release.sh all <patch|minor|major> [--body-file <file>]
#                                 open, merge, tag, and wait in turn (installing is make update)
#
# The repository is GH_REPO=<owner/repo> if set, else the GitHub repository of this checkout's
# origin remote; every gh call is given it. Nothing here changes the current branch or working
# tree. Needs gh (logged in), git, and Node 24+.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
REPO=""
PR_NUMBER="" # set by open, for all
WORK=""
COAUTHOR="Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
FOOTER="$(printf '\xf0\x9f\xa4\x96') Generated with [Claude Code](https://claude.com/claude-code)"

usage() {
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  echo "release: $*" >&2
  exit 1
}

bad_usage() {
  echo "release: $*" >&2
  echo "Run with --help for usage." >&2
  exit 2
}

say() {
  echo "==> $*"
}

cleanup() {
  if [ -n "$WORK" ]; then
    git -C "$ROOT" worktree remove --force "$WORK/tree" >/dev/null 2>&1 || true
    rm -rf "$WORK"
    git -C "$ROOT" worktree prune >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# --- helpers -----------------------------------------------------------------------------

# owner/repo from a GitHub remote URL (https://, git@github.com:, or ssh://git@github.com/).
repo_from_url() {
  local path
  case "$1" in
    https://github.com/*) path="${1#https://github.com/}" ;;
    git@github.com:*) path="${1#git@github.com:}" ;;
    ssh://git@github.com/*) path="${1#ssh://git@github.com/}" ;;
    *) return 1 ;;
  esac
  path="${path%/}"
  path="${path%.git}"
  [[ "$path" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
  echo "$path"
}

resolve_repo() {
  command -v gh >/dev/null 2>&1 ||
    die "gh (GitHub CLI) is not installed: brew install gh, then gh auth login"
  gh auth status >/dev/null 2>&1 || die "gh is not logged in to GitHub: run gh auth login"
  if [ -n "${GH_REPO:-}" ]; then
    REPO="$GH_REPO"
  else
    local url=""
    url="$(git -C "$ROOT" remote get-url origin 2>/dev/null)" || url=""
    REPO="$(repo_from_url "$url")" ||
      die "can't tell the GitHub repository from origin (${url:-none}); set GH_REPO=<owner/repo>"
  fi
}

fetch() {
  git -C "$ROOT" fetch --quiet --tags origin main ||
    die "git fetch origin failed"
}

is_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# The "version" of the package.json read on stdin.
json_version() {
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).version)'
}

main_version() {
  git -C "$ROOT" show origin/main:desktop/package.json | json_version
}

# The highest v<x.y.z> tag, or nothing.
last_tag() {
  git -C "$ROOT" tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true
}

# Subject lines on origin/main since the last tag, without version bumps.
change_lines() {
  local tag range=origin/main
  tag="$(last_tag)"
  [ -z "$tag" ] || range="$tag..origin/main"
  git -C "$ROOT" log --no-merges --format=%s "$range" | grep -vE '^desktop: version [0-9]' || true
}

# The SHA a remote tag points at (peeled for an annotated tag), or nothing (exit 0).
remote_tag_sha() {
  local out
  out="$(git -C "$ROOT" ls-remote --tags origin "refs/tags/$1" "refs/tags/$1^{}")"
  { echo "$out" | grep -F "refs/tags/$1^{}" || echo "$out" | grep -F "refs/tags/$1"; } |
    head -1 | cut -f1 || true
}

part_arg() {
  case "${1:-}" in
    patch | minor | major) echo "$1" ;;
    *) bad_usage "give patch, minor, or major" ;;
  esac
}

# --- commands ----------------------------------------------------------------------------

cmd_changes() {
  fetch
  local tag lines
  tag="$(last_tag)"
  lines="$(change_lines)"
  echo "Last release: ${tag:-none} (origin/main is at version $(main_version))"
  [ -n "$lines" ] || die "no changes on origin/main since ${tag:-the start}; nothing to release"
  echo "Changes on origin/main since ${tag:-the start}:"
  echo "$lines" | sed 's/^/- /'
}

cmd_open() {
  local part="" body_file="" dry_run=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --body-file)
        [ $# -ge 2 ] || bad_usage "--body-file needs a file"
        body_file="$2"
        shift
        ;;
      --dry-run) dry_run=1 ;;
      -*) bad_usage "unknown option $1" ;;
      *)
        [ -z "$part" ] || bad_usage "give one of patch, minor, major"
        part="$(part_arg "$1")"
        ;;
    esac
    shift
  done
  [ -n "$part" ] || bad_usage "open needs patch, minor, or major"
  [ -z "$body_file" ] || [ -s "$body_file" ] || die "body file $body_file is missing or empty"

  resolve_repo
  fetch
  local open_prs
  open_prs="$(gh pr list --repo "$REPO" --state open --limit 100 --json number,title,url \
    --jq '.[] | select(.title | startswith("desktop: version ")) | "#\(.number) \(.title) \(.url)"')"
  [ -z "$open_prs" ] || die "a release PR is already open; merge or close it first:
$open_prs"

  local lines
  lines="$(change_lines)"
  [ -n "$lines" ] || die "no changes on origin/main since $(last_tag); nothing to release"

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/plutus-release.XXXXXX")"
  git -C "$ROOT" worktree add --quiet --detach "$WORK/tree" origin/main
  (cd "$WORK/tree" && node desktop/scripts/version.mjs bump "$part" >/dev/null 2>&1) ||
    die "version bump failed (run node desktop/scripts/version.mjs bump $part to see why)"
  # Only the two version lines may change (npm must not rewrite the lockfile).
  [ "$(git -C "$WORK/tree" diff --numstat HEAD~1 | awk '{print $1 $2 $3}' | sort | tr '\n' ' ')" = \
    "11desktop/package.json 11package-lock.json " ] ||
    die "the version bump changed more than the two version lines:
$(git -C "$WORK/tree" diff --stat HEAD~1)"
  local version branch tag
  version="$(json_version <"$WORK/tree/desktop/package.json")"
  is_version "$version" || die "bumped version looks wrong: $version"
  tag="v$version"
  branch="claude/release-${version//./-}"
  git -C "$WORK/tree" commit --amend --quiet -m "desktop: version $version" -m "$COAUTHOR"

  [ -z "$(remote_tag_sha "$tag")" ] || die "tag $tag already exists on origin"
  [ -z "$(git -C "$ROOT" ls-remote --heads origin "refs/heads/$branch")" ] ||
    die "branch $branch already exists on origin; delete it or open its PR by hand"

  {
    if [ -n "$body_file" ]; then
      cat "$body_file"
    else
      echo "Changes since $(last_tag):"
      echo
      echo "$lines" | sed 's/^/- /'
    fi
    echo
    echo "After merge: tag the merged commit \`$tag\` and push the tag; \`release.yml\` builds and publishes the release."
    echo
    echo "$FOOTER"
  } >"$WORK/body.md"

  if [ "$dry_run" = 1 ]; then
    say "dry run: would push $branch and open \"desktop: version $version\" on $REPO"
    git -C "$WORK/tree" show --stat --format='%B' HEAD
    echo "--- PR body ---"
    cat "$WORK/body.md"
    return 0
  fi

  say "pushing $branch"
  git -C "$WORK/tree" push --quiet origin "HEAD:refs/heads/$branch"
  local url
  url="$(gh pr create --repo "$REPO" --base main --head "$branch" \
    --title "desktop: version $version" --body-file "$WORK/body.md")"
  PR_NUMBER="${url##*/}"
  say "opened PR #$PR_NUMBER for version $version: $url"
}

cmd_merge() {
  local n="${1:-}"
  [[ "$n" =~ ^[0-9]+$ ]] || bad_usage "merge needs a PR number"
  resolve_repo
  local info title base state
  info="$(gh pr view "$n" --repo "$REPO" --json title,baseRefName,state \
    --jq '[.title, .baseRefName, .state] | join("\t")')" || die "can't read PR #$n"
  IFS=$'\t' read -r title base state <<<"$info"
  [[ "$title" =~ ^desktop:\ version\ [0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    die "PR #$n is \"$title\", not a release PR (\"desktop: version X.Y.Z\"); refusing to merge it"
  [ "$base" = main ] || die "PR #$n targets $base, not main; refusing to merge it"
  if [ "$state" = MERGED ]; then
    say "PR #$n ($title) is already merged"
    return 0
  fi
  [ "$state" = OPEN ] || die "PR #$n is $state"

  local tries=0
  while [ "$(gh pr checks "$n" --repo "$REPO" --json name --jq length 2>/dev/null || echo 0)" = 0 ]; do
    tries=$((tries + 1))
    [ "$tries" -le 24 ] || die "no checks registered on PR #$n after 2 minutes"
    sleep 5
  done
  say "waiting for the checks on PR #$n"
  if ! gh pr checks "$n" --repo "$REPO" --watch --fail-fast --interval 20 >/dev/null; then
    gh pr checks "$n" --repo "$REPO" --json name,bucket,link \
      --jq '.[] | select(.bucket != "pass" and .bucket != "skipping") | "  \(.bucket): \(.name) \(.link)"' >&2 || true
    die "checks on PR #$n did not pass; not merging (gh run view <run id> --log-failed shows why)"
  fi
  say "checks passed; squash-merging PR #$n"
  gh pr merge "$n" --repo "$REPO" --squash --delete-branch
  state="$(gh pr view "$n" --repo "$REPO" --json state --jq .state)"
  [ "$state" = MERGED ] || die "PR #$n is $state after merging"
  say "merged PR #$n ($title)"
}

cmd_tag() {
  resolve_repo
  fetch
  local version tag commit set_to
  version="$(main_version)"
  is_version "$version" || die "origin/main has version $version"
  tag="v$version"
  # The last commit that changed the version line: the squash-merged release commit.
  commit="$(git -C "$ROOT" log -1 --format=%H -G'"version":' origin/main -- desktop/package.json)"
  [ -n "$commit" ] || die "can't find the commit that set version $version"
  set_to="$(git -C "$ROOT" show "$commit:desktop/package.json" | json_version)"
  [ "$set_to" = "$version" ] || die "commit $commit sets version $set_to, not $version"

  local remote local_sha
  remote="$(remote_tag_sha "$tag")"
  if [ -n "$remote" ]; then
    [ "$remote" = "$commit" ] || die "$tag already exists on origin at $remote, not $commit"
    say "$tag is already on origin at $(git -C "$ROOT" log -1 --format='%h %s' "$commit")"
    return 0
  fi
  local_sha="$(git -C "$ROOT" rev-parse -q --verify "refs/tags/$tag^{commit}" || true)"
  if [ -z "$local_sha" ]; then
    git -C "$ROOT" tag "$tag" "$commit"
  elif [ "$local_sha" != "$commit" ]; then
    die "a local tag $tag points at $local_sha, not $commit; delete it (git tag -d $tag) and rerun"
  fi
  git -C "$ROOT" push --quiet origin "refs/tags/$tag"
  say "pushed $tag at $(git -C "$ROOT" log -1 --format='%h %s' "$commit")"
}

cmd_wait() {
  local version="${1:-}"
  resolve_repo
  if [ -z "$version" ]; then
    fetch
    version="$(main_version)"
  fi
  version="${version#v}"
  is_version "$version" || bad_usage "versions look like 0.6.1, got $version"
  local tag="v$version" run="" tries=0
  while :; do
    run="$(gh run list --repo "$REPO" --workflow release.yml --branch "$tag" --limit 1 \
      --json databaseId --jq '.[0].databaseId // empty')"
    [ -z "$run" ] || break
    tries=$((tries + 1))
    [ "$tries" -le 24 ] || die "no Release workflow run for $tag after 2 minutes (was the tag pushed?)"
    sleep 5
  done
  say "watching Release run $run for $tag (about 15 minutes)"
  if ! gh run watch "$run" --repo "$REPO" --exit-status --compact --interval 30 >/dev/null; then
    gh run view "$run" --repo "$REPO" --log-failed 2>&1 | tail -60 >&2 || true
    die "the Release workflow for $tag failed: gh run view $run --repo $REPO --log-failed"
  fi
  local assets name missing=""
  assets="$(gh release view "$tag" --repo "$REPO" --json assets --jq '.assets[].name')" ||
    die "the workflow passed but there is no release $tag"
  for name in "Plutus-$version-arm64.dmg" "Plutus-$version-arm64.zip" \
    "Plutus-$version-x64.dmg" "Plutus-$version-x64.zip"; do
    grep -qxF "$name" <<<"$assets" || missing="$missing $name"
  done
  [ -z "$missing" ] || die "release $tag is missing:$missing"
  say "release $tag is published with its four files: $(gh release view "$tag" --repo "$REPO" --json url --jq .url)"
}

cmd_all() {
  cmd_open "$@"
  [ -n "$PR_NUMBER" ] || return 0 # --dry-run
  cmd_merge "$PR_NUMBER"
  cmd_tag
  cmd_wait
}

# --- main --------------------------------------------------------------------------------

command="${1:-}"
[ $# -eq 0 ] || shift
case "$command" in
  changes) cmd_changes ;;
  open) cmd_open "$@" ;;
  merge) cmd_merge "$@" ;;
  tag) cmd_tag ;;
  wait) cmd_wait "$@" ;;
  all) cmd_all "$@" ;;
  -h | --help) usage ;;
  "") bad_usage "give a command" ;;
  *) bad_usage "unknown command $command" ;;
esac
