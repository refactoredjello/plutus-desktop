/**
 * Release versioning (scripts/version.mjs runs these; nothing in the app imports them).
 *
 * The app version is desktop/package.json "version", a plain x.y.z. A release is the tag
 * v<version> on main; the release workflow refuses a tag that does not match the package.
 */

export type BumpPart = 'patch' | 'minor' | 'major'

const PARTS: readonly string[] = ['patch', 'minor', 'major']
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function bumpPart(arg: string | undefined): BumpPart {
  if (arg !== undefined && PARTS.includes(arg)) return arg as BumpPart
  throw new Error(`usage: npm run version:bump -- patch|minor|major (got ${arg ?? 'nothing'})`)
}

export function isVersion(value: string): boolean {
  return VERSION.test(value)
}

export function tagFor(version: string): string {
  return `v${version}`
}

/** Null when `tag` (a tag name or refs/tags/...) releases `version`; otherwise why not. */
export function releaseTagProblem(tag: string, version: string): string | null {
  const name = tag.replace(/^refs\/tags\//, '')
  if (!name.startsWith('v') || !isVersion(name.slice(1))) {
    return `release tags look like v<x.y.z>, got "${name}"`
  }
  if (name !== tagFor(version)) {
    return `tag ${name} does not match desktop/package.json version ${version}; bump the version or fix the tag`
  }
  return null
}
