#!/usr/bin/env node
/**
 * Build the package when it was installed from a git checkout.
 *
 * `npm install <git-url>` runs `prepare` after cloning, but the repository has
 * no build output committed, so the CLI would be missing `dist/` and the
 * installed `bin` would dangle. That is why `prepare` exists.
 *
 * `npm install <tarball>` also runs `prepare`, but the published tarball ships
 * only compiled output — never `src/` or `tsconfig.json` — so running `tsc`
 * there fails and would break every install (including the lifecycle tests that
 * install the packed tarball). This guard distinguishes the two cases: it builds
 * only when the TypeScript sources and config are present, and otherwise exits
 * successfully without touching the already-compiled files.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const hasSources = existsSync(join(packageRoot, 'src')) && existsSync(join(packageRoot, 'tsconfig.json'))

if (!hasSources) {
  // Published tarball: dist/ is already present and correct.
  process.exit(0)
}

const result = spawnSync('tsc', ['-p', 'tsconfig.json'], {
  cwd: packageRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.error !== undefined) {
  process.stderr.write(`prepare: failed to run tsc: ${result.error.message}\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)
