import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Install-from-tarball integration test (docs/open-source-release/
 * 02-installation-packaging.md, phase 6): pack the release artifact and
 * exercise the installed `dsh-multiuser` CLI exactly as a consumer would —
 * `--help` and `doctor` from an empty directory with no development
 * checkout. `doctor` must resolve compatibility.json inside the installed
 * package and must not create any files.
 *
 * Requires `DSH_INTEGRATION_BIN` pointing at a real `dsh` executable and
 * `DSH_PACK_DIR` pointing at a directory holding the packed `.tgz`
 * (CI builds it with `pnpm pack --pack-destination`). Skipped otherwise.
 */
const dshBin = process.env.DSH_INTEGRATION_BIN
const packDir = process.env.DSH_PACK_DIR
const dshBinExists = dshBin !== undefined && existsSync(dshBin)
const describePack = dshBinExists && packDir !== undefined && existsSync(packDir) ? describe : describe.skip

function findTarball(): string {
  const candidates = readdirSync(packDir!).filter(name => name.endsWith('.tgz'))
  if (candidates.length === 0) throw new Error(`no .tgz found in ${packDir}`)
  return join(packDir!, candidates[0]!)
}

function npmInstall(directory: string, tarball: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('npm', ['install', tarball], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolvePromise() : reject(new Error(`npm install failed: ${output.slice(-1_000)}`)))
  })
}

const temporaryRoots: string[] = []

afterAll(async () => {
  await Promise.all(temporaryRoots.map(root => rm(root, { recursive: true, force: true })))
})

describePack('installed tarball', () => {
  let consumerDir: string
  let cli: string

  beforeAll(async () => {
    consumerDir = await mkdtemp(join(tmpdir(), 'dsh-multiuser-pack-consumer-'))
    temporaryRoots.push(consumerDir)
    await npmInstall(consumerDir, findTarball())
    cli = join(consumerDir, 'node_modules/.bin/dsh-multiuser')
    if (!existsSync(cli)) throw new Error(`installed CLI not found at ${cli}`)
  }, 300_000)

  it('answers --help from the installed package', async () => {
    const result = await run(cli, ['--help'], consumerDir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('doctor')
    expect(result.stdout).toContain('install')
    expect(result.stdout).toContain('uninstall')
  }, 60_000)

  it('runs doctor against a real DSH and resolves compatibility.json from the installed package', async () => {
    const dataDir = join(consumerDir, 'data')
    const result = await run(cli, [
      'doctor',
      '--dsh-command', dshBin!,
      '--db', join(dataDir, 'gateway.sqlite'),
      '--data-root', join(dataDir, 'users'),
      '--profile-source', join(consumerDir, 'node_modules/dsh-multiuser/profiles/user-runtime'),
      '--json',
    ], consumerDir)
    expect(result.code).toBe(1) // SSO intentionally unconfigured in this probe
    const parsed = JSON.parse(result.stdout) as { ok: boolean; results: Array<{ code: string; ok: boolean; detail: string }> }
    expect(parsed.results.find(entry => entry.code === 'DSH_VERSION')?.ok).toBe(true)
    expect(parsed.results.find(entry => entry.code === 'DSH_COMPATIBILITY')?.ok).toBe(true)
    expect(parsed.results.find(entry => entry.code === 'PROFILE_COMPOSITION')?.ok).toBe(true)
    expect(parsed.results.find(entry => entry.code === 'SSO_CONFIG')?.ok).toBe(false)
  }, 180_000)

  it('leaves the data directory untouched (read-only semantics)', () => {
    expect(existsSync(join(consumerDir, 'data'))).toBe(false)
  })
})

/**
 * Run the installed CLI from the consumer directory, so the test cannot pass by
 * accidentally resolving files from the development checkout.
 */
function run(command: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', code => resolvePromise({ code, stdout }))
  })
}
