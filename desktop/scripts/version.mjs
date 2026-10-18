// Release versioning for the desktop app (logic and tests in src/lib/version.ts).
//
//   node scripts/version.mjs bump patch|minor|major   bump desktop/package.json and commit
//   node scripts/version.mjs check-tag <tag>          exit 1 unless <tag> is v<package version>
//
// Bumping never tags: tag v<version> on main when releasing (see README.md "Releases").
// Node strips the TypeScript types when importing the .ts module (Node 24+).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bumpPart, releaseTagProblem, tagFor } from '../src/lib/version.ts'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(desktop, '..')

const packageVersion = () =>
  JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).version

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts })

function bump(arg) {
  const part = bumpPart(arg)
  if (run('git', ['status', '--porcelain']).trim() !== '') {
    throw new Error('the working tree has changes; commit or set them aside before bumping')
  }
  const before = packageVersion()
  // Updates desktop/package.json and the root package-lock.json together.
  run('npm', ['version', part, '--no-git-tag-version', '--workspace', 'desktop'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const after = packageVersion()
  run('git', ['add', 'desktop/package.json', 'package-lock.json'])
  run('git', [
    'commit',
    '--quiet',
    '-m',
    `desktop: version ${after}`,
  ])
  console.log(`${before} -> ${after}, committed. To release, on main: git tag ${tagFor(after)} && git push origin ${tagFor(after)}`)
}

function checkTag(tag) {
  const version = packageVersion()
  const problem = releaseTagProblem(tag ?? '', version)
  if (problem) throw new Error(problem)
  console.log(`tag ${tag} matches desktop/package.json version ${version}`)
}

const [command, arg] = process.argv.slice(2)
try {
  if (command === 'bump') bump(arg)
  else if (command === 'check-tag') checkTag(arg)
  else throw new Error('usage: node scripts/version.mjs bump patch|minor|major | check-tag <tag>')
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
