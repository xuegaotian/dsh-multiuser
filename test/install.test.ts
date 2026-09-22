import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, lstat, readlink } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { lookup } from 'node:dns/promises'
import { type AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyAppTree, packageRoot, planInstall, runDoctor, runInstall, runStatus, runUninstall, systemdEnvPath, systemdKeysPath, systemdServicePath, type InstallOptions } from '../src/install.js'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-multiuser-install-test-'))
  roots.push(root)
  return root
}

/** A DSH stand-in: prints a supported-looking version and exits 0. */
const fakeDsh = [
  '#!/usr/bin/env node',
  'const arg = process.argv[process.argv.length - 1]',
  'if (arg === "--version") { console.log("0.1.5-rc.1"); process.exit(0) }',
  'process.exit(0)',
].join('\n')

async function writeFakeDsh(root: string): Promise<string> {
  const path = join(root, 'fake-dsh.mjs')
  await writeFile(path, fakeDsh, 'utf8')
  await chmod(path, 0o755)
  return path
}

function installOptions(overrides: Partial<InstallOptions> = {}): InstallOptions {
  return {
    mode: 'local',
    dryRun: false,
    appDir: '',
    dataDir: '',
    dshCommand: 'node',
    dshArgs: '[]',
    profile: 'user-runtime',
    profileSource: join(packageRoot(), 'profiles/user-runtime'),
    host: '127.0.0.1',
    port: '18088',
    serviceUser: 'dsh-multiuser',
    systemRoot: '',
    ...overrides,
  }
}

/** Run a systemd install into `systemRoot`, using a fake dsh for the verify step. */
async function runSystemdInstall(systemRoot: string, overrides: Partial<InstallOptions> = {}): Promise<void> {
  const dsh = await writeFakeDsh(systemRoot)
  const ssoPublicKey = join(systemRoot, 'sso-public.pem')
  await writeFile(ssoPublicKey, 'test public key fixture\n', 'utf8')
  const options = installOptions({
    mode: 'systemd',
    appDir: join(systemRoot, 'app'),
    dataDir: join(systemRoot, 'data'),
    systemRoot,
    dshCommand: dsh,
    ssoPublicKey: [`test=${ssoPublicKey}`],
    ssoIssuer: 'test-idp',
    ssoAudience: 'dsh-multiuser',
    ssoOrigin: 'https://sso.example.com',
    ...overrides,
  })
  for (const entry of options.ssoPublicKey ?? []) {
    const separator = entry.indexOf('=')
    if (separator < 1) continue
    const path = entry.slice(separator + 1)
    const stagedPath = path.startsWith(`${systemRoot}/`) ? path : join(systemRoot, path.slice(1))
    await mkdir(join(stagedPath, '..'), { recursive: true })
    await writeFile(stagedPath, 'test public key fixture\n', 'utf8')
  }
  await runInstall(options)
}

/** Capture everything written to stdout by `fn` (runInstall/runStatus print there). */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  try {
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(chunk.toString())
      return true
    }) as (chunk: string | Uint8Array) => boolean
    await fn()
  } finally {
    process.stdout.write = original
  }
  return chunks.join('')
}

describe('install planning', () => {
  it('resolves every target path absolutely and lists ordered steps', () => {
    const plan = planInstall(installOptions({ appDir: 'relative/app', dataDir: 'relative/data' }))
    expect(plan.appDir.startsWith('/')).toBe(true)
    expect(plan.dataDir.startsWith('/')).toBe(true)
    expect(plan.dbPath).toBe(join(plan.dataDir, 'gateway.sqlite'))
    expect(plan.dataRoot).toBe(join(plan.dataDir, 'users'))
    expect(plan.profileSource).toBe(join(plan.appDir, 'profiles/user-runtime'))
    expect(plan.steps.length).toBeGreaterThan(0)
    expect(plan.steps[0]).toContain('copy application files')
  })

  it('adds systemd unit steps only in systemd mode', () => {
    const local = planInstall(installOptions({ mode: 'local' }))
    const systemd = planInstall(installOptions({ mode: 'systemd' }))
    expect(local.steps.some(step => step.includes('systemd'))).toBe(false)
    expect(systemd.steps.some(step => step.includes('service unit'))).toBe(true)
    expect(systemd.serviceFile).toBe('/etc/systemd/system/dsh-multiuser.service')
  })

  it('passes SSO options into the gateway arguments', () => {
    const plan = planInstall(installOptions({ ssoIssuer: 'example-idp', ssoAudience: 'dsh-multiuser', ssoOrigin: 'https://sso.example.com', ssoPublicKey: ['sso-1=/keys/1.pem'] }))
    expect(plan.gatewayArgs).toContain('--sso-issuer')
    expect(plan.gatewayArgs).toContain('example-idp')
  })
})

describe('doctor', () => {
  it('flags a DSH version absent from compatibility.json', async () => {
    const root = await tempRoot()
    const dsh = await writeFakeDshVersion(root, '9.9.9-not-a-version')
    const { ok, results } = await runDoctor({
      dshCommand: process.execPath,
      dshArgs: JSON.stringify([dsh]),
      db: join(root, 'gateway.sqlite'),
      dataRoot: join(root, 'users'),
      profile: 'user-runtime',
      profileSource: join(packageRoot(), 'profiles/user-runtime'),
      ssoPublicKey: ['sso-1=/nonexistent.pem'],
      ssoIssuer: 'example-idp',
      ssoAudience: 'dsh-multiuser',
      ssoOrigin: 'https://sso.example.com',
    })
    const compatibility = results.find(result => result.code === 'DSH_COMPATIBILITY')
    expect(compatibility?.ok).toBe(false)
    expect(compatibility?.detail).toContain('9.9.9-not-a-version')
    expect(ok).toBe(false)
  }, 120_000)

  it('reports a tested DSH version as supported', async () => {
    const root = await tempRoot()
    const dsh = await writeFakeDshVersion(root, '0.1.5-rc.1')
    const { results } = await runDoctor({
      dshCommand: process.execPath,
      dshArgs: JSON.stringify([dsh]),
      db: join(root, 'gateway.sqlite'),
      dataRoot: join(root, 'users'),
      profile: 'user-runtime',
      profileSource: join(packageRoot(), 'profiles/user-runtime'),
      ssoPublicKey: [],
      ssoIssuer: 'example-idp',
      ssoAudience: 'dsh-multiuser',
      ssoOrigin: 'https://sso.example.com',
    })
    expect(results.find(result => result.code === 'DSH_COMPATIBILITY')?.ok).toBe(true)
  }, 120_000)

  it('flags world-readable data permissions', async () => {
    const root = await tempRoot()
    const dataRoot = join(root, 'users')
    await mkdir(dataRoot, { recursive: true })
    await chmod(dataRoot, 0o777)
    const dsh = await writeFakeDshVersion(root, '0.1.5-rc.1')
    const { results } = await runDoctor({
      dshCommand: process.execPath,
      dshArgs: JSON.stringify([dsh]),
      db: join(root, 'gateway.sqlite'),
      dataRoot,
      profile: 'user-runtime',
      profileSource: join(packageRoot(), 'profiles/user-runtime'),
      ssoPublicKey: [],
      ssoIssuer: 'example-idp',
      ssoAudience: 'dsh-multiuser',
      ssoOrigin: 'https://sso.example.com',
    })
    const permission = results.find(result => result.code === 'DATA_PERMISSION')
    expect(permission?.ok).toBe(false)
    expect(permission?.detail).toContain('chmod 0700')
  }, 120_000)

  it('rejects incomplete SSO configuration without printing key material', async () => {
    const root = await tempRoot()
    const dsh = await writeFakeDshVersion(root, '0.1.5-rc.1')
    const { ok, results } = await runDoctor({
      dshCommand: process.execPath,
      dshArgs: JSON.stringify([dsh]),
      db: join(root, 'gateway.sqlite'),
      dataRoot: join(root, 'users'),
      profile: 'user-runtime',
      profileSource: join(packageRoot(), 'profiles/user-runtime'),
      ssoIssuer: 'example-idp',
      ssoAudience: 'dsh-multiuser',
      // ssoOrigin missing on purpose
    })
    const sso = results.find(result => result.code === 'SSO_CONFIG')
    expect(sso?.ok).toBe(false)
    expect(sso?.detail).toContain('incomplete')
    expect(JSON.stringify(results)).not.toContain('BEGIN PUBLIC KEY')
    expect(ok).toBe(false)
  }, 120_000)

  it('flags insecure cookies', async () => {
    const root = await tempRoot()
    const dsh = await writeFakeDshVersion(root, '0.1.5-rc.1')
    const { results } = await runDoctor({
      dshCommand: process.execPath,
      dshArgs: JSON.stringify([dsh]),
      db: join(root, 'gateway.sqlite'),
      dataRoot: join(root, 'users'),
      profile: 'user-runtime',
      profileSource: join(packageRoot(), 'profiles/user-runtime'),
      ssoPublicKey: [],
      ssoIssuer: 'example-idp',
      ssoAudience: 'dsh-multiuser',
      ssoOrigin: 'https://sso.example.com',
      insecureCookies: true,
    })
    expect(results.find(result => result.code === 'SECURE_COOKIES')?.ok).toBe(false)
  }, 120_000)
})

describe('copyAppTree', () => {
  it('copies dist, profiles, packages, and metadata without devDependencies', async () => {
    const root = await tempRoot()
    const target = join(root, 'app')
    await copyAppTree(target)
    expect(existsSync(join(target, 'dist/src/cli.js'))).toBe(true)
    expect(existsSync(join(target, 'profiles/user-runtime/package.json'))).toBe(true)
    expect(existsSync(join(target, 'packages/bundle/user-runtime/cordis.patch.yml'))).toBe(true)
    expect(existsSync(join(target, 'compatibility.json'))).toBe(true)
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as { bin?: Record<string, string>; devDependencies?: Record<string, string> }
    expect(manifest.bin?.['dsh-multiuser']).toBe('dist/src/cli.js')
    expect(manifest.devDependencies).toBeUndefined()
  })
})

describe('install and uninstall lifecycle', () => {
  it('dry-run creates nothing and reports the plan', async () => {
    const root = await tempRoot()
    const appDir = join(root, 'app')
    const dataDir = join(root, 'data')
    await runInstall(installOptions({ dryRun: true, appDir, dataDir }))
    expect(existsSync(appDir)).toBe(false)
    expect(existsSync(dataDir)).toBe(false)
  })

  it('uninstall keeps data by default and purges only with --purge-data', async () => {
    const root = await tempRoot()
    const appDir = join(root, 'app')
    const dataDir = join(root, 'data')
    await mkdir(join(dataDir, 'keep'), { recursive: true })
    await writeFile(join(dataDir, 'keep/marker.txt'), 'data', 'utf8')
    await runUninstall(appDir, dataDir, false, false)
    expect(existsSync(join(dataDir, 'keep/marker.txt'))).toBe(true)
    await runUninstall(appDir, dataDir, true, false)
    expect(existsSync(dataDir)).toBe(false)
  })

  it('refuses to purge the user home directory', async () => {
    await expect(runUninstall('/tmp/app-that-does-not-exist', process.env.HOME ?? '/home/user', true, false)).rejects.toThrow('refusing')
  })

  it('restores the previous application when doctor fails after replacement', async () => {
    const root = await tempRoot()
    const appDir = join(root, 'app')
    const dataDir = join(root, 'data')
    const dsh = await writeFakeDsh(root)
    await mkdir(appDir, { recursive: true })
    await writeFile(join(appDir, 'previous-version.txt'), 'keep me\n', 'utf8')

    await expect(runInstall(installOptions({ appDir, dataDir, dshCommand: dsh }))).rejects.toThrow('failed doctor checks')

    expect(await readFile(join(appDir, 'previous-version.txt'), 'utf8')).toBe('keep me\n')
    expect(existsSync(`${appDir}.previous`)).toBe(false)
  }, 120_000)

  it('restores the previous application when systemd setup fails after doctor', async () => {
    const root = await tempRoot()
    const appDir = join(root, 'app')
    const dataDir = join(root, 'data')
    const dsh = await writeFakeDsh(root)
    const ssoPublicKey = join(root, 'sso-public.pem')
    await mkdir(appDir, { recursive: true })
    await writeFile(join(appDir, 'previous-version.txt'), 'keep me\n', 'utf8')
    await writeFile(ssoPublicKey, 'test public key fixture\n', 'utf8')
    await mkdir(join(root, 'etc'), { recursive: true })
    await writeFile(join(root, 'etc/systemd'), 'blocks the unit directory\n', 'utf8')

    await expect(runInstall(installOptions({
      mode: 'systemd',
      appDir,
      dataDir,
      systemRoot: root,
      dshCommand: dsh,
      ssoPublicKey: [`test=${ssoPublicKey}`],
      ssoIssuer: 'test-idp',
      ssoAudience: 'dsh-multiuser',
      ssoOrigin: 'https://sso.example.com',
    }))).rejects.toThrow()

    expect(await readFile(join(appDir, 'previous-version.txt'), 'utf8')).toBe('keep me\n')
    expect(existsSync(`${appDir}.previous`)).toBe(false)
  }, 120_000)
})

async function writeFakeDshVersion(root: string, version: string): Promise<string> {
  const path = join(root, `dsh-${version.replaceAll(/[^a-zA-Z0-9.-]/gu, '-')}.mjs`)
  await writeFile(path, `console.log('${version}')\n`, 'utf8')
  await chmod(path, 0o755)
  return path
}

describe('systemd install', () => {
  it('writes unit, env (0600), and keys dir (0750) under --system-root', async () => {
    const root = await tempRoot()
    await runSystemdInstall(root)
    const unit = systemdServicePath(root)
    expect(existsSync(unit)).toBe(true)
    const env = systemdEnvPath(root)
    expect(existsSync(env)).toBe(true)
    expect(statSync(env).mode & 0o777).toBe(0o600)
    const keys = systemdKeysPath(root)
    expect(existsSync(keys)).toBe(true)
    expect(statSync(keys).mode & 0o777).toBe(0o750)
  }, 120_000)

  it('emits an acceptance-compliant unit with SSO listed once per key', async () => {
    const root = await tempRoot()
    await runSystemdInstall(root, {
      ssoPublicKey: ['k1=/etc/dsh-multiuser/keys/sso-1.pem', 'k2=/etc/dsh-multiuser/keys/sso-2.pem'],
      ssoIssuer: 'example-idp',
      ssoAudience: 'dsh-multiuser',
      ssoOrigin: 'https://sso.example.com',
    })
    const unit = await readFile(systemdServicePath(root), 'utf8')
    for (const token of ['User=', 'Group=', 'WorkingDirectory=', 'EnvironmentFile=', 'UMask=0077', 'KillMode=control-group', 'Restart=on-failure']) {
      expect(unit).toContain(token)
    }
    expect(unit).not.toContain('--insecure-cookies')
    // each --sso-public-key appears exactly once, on its own continued line
    const ssoOccurrences = unit.match(/--sso-public-key/g)?.length ?? 0
    expect(ssoOccurrences).toBe(2)
    expect(unit.split('\n').filter(line => line.includes('--sso-public-key')).length).toBe(2)
    // --allowed-host is the final argument line (no backslash continuation)
    const lines = unit.split('\n')
    const allowedIndex = lines.findIndex(line => line.trim().startsWith('--allowed-host'))
    expect(allowedIndex).toBeGreaterThan(0)
    expect(lines[allowedIndex]!.trimEnd().endsWith('\\')).toBe(false)
    expect(lines.slice(allowedIndex + 1).join('\n')).not.toContain('--sso-public-key')
  }, 120_000)

  // Regression test for the bug where `--allowed-host` was appended as a dangling
  // line outside ExecStart (so it fell back to 127.0.0.1:18088 and every proxied
  // request 421'd). We re-join ExecStart logical lines by systemd continuation
  // rules and assert the flag — and its value — live inside ExecStart.
  it('keeps --allowed-host (and SSO params) inside the continued ExecStart', async () => {
    const root = await tempRoot()
    await runSystemdInstall(root, {
      allowedHost: 'dsh.example.com',
      ssoPublicKey: ['k1=/etc/dsh-multiuser/keys/sso-1.pem', 'k2=/etc/dsh-multiuser/keys/sso-2.pem'],
      ssoIssuer: 'example-idp',
      ssoAudience: 'dsh-multiuser',
      ssoOrigin: 'https://sso.example.com',
    })
    const unit = await readFile(systemdServicePath(root), 'utf8')
    // Reconstruct the logical ExecStart value by following trailing `\` continuations.
    const lines = unit.split('\n')
    const execIndex = lines.findIndex(line => line.trimStart().startsWith('ExecStart='))
    expect(execIndex).toBeGreaterThanOrEqual(0)
    let logical = lines[execIndex]!.slice(lines[execIndex]!.indexOf('=') + 1).trim()
    let i = execIndex + 1
    while (i < lines.length && lines[i - 1]!.trimEnd().endsWith('\\')) {
      logical += ' ' + lines[i]!.trim()
      i++
    }
    // --allowed-host must be a single logical token inside ExecStart, with the
    // exact value that was passed on the command line.
    expect(logical).toMatch(/--allowed-host\s+dsh\.example\.com/u)
    expect(logical).toContain('--sso-public-key k1=/etc/dsh-multiuser/keys/sso-1.pem')
    expect(logical).toContain('--sso-public-key k2=/etc/dsh-multiuser/keys/sso-2.pem')
    expect(logical).toContain('--sso-issuer example-idp')
    expect(logical).toContain('--sso-audience dsh-multiuser')
    expect(logical).toContain('--sso-origin https://sso.example.com')
    // And the joined ExecStart must not still reference a dangling fallback host.
    expect(logical).not.toContain('127.0.0.1:18088')
  }, 120_000)

  it('preserves an existing env file and the data directory on re-install', async () => {
    const root = await tempRoot()
    await runSystemdInstall(root)
    const env = systemdEnvPath(root)
    await writeFile(env, 'OPERATOR_SECRET=do-not-overwrite\n', { mode: 0o600 })
    const marker = join(root, 'data', 'keep.txt')
    await writeFile(marker, 'data', 'utf8')
    await runSystemdInstall(root)
    const after = await readFile(env, 'utf8')
    expect(after).toContain('OPERATOR_SECRET=do-not-overwrite')
    expect(existsSync(marker)).toBe(true)
  }, 120_000)

  it('refuses systemd install without root and without --system-root (writes nothing to /etc)', async () => {
    const root = await tempRoot()
    await expect(runInstall(installOptions({
      mode: 'systemd',
      appDir: join(root, 'app'),
      dataDir: join(root, 'data'),
      systemRoot: '',
    }))).rejects.toThrow(/sudo/u)
    expect(existsSync('/etc/systemd/system/dsh-multiuser.service')).toBe(false)
    expect(existsSync('/etc/dsh-multiuser/gateway.env')).toBe(false)
  }, 120_000)

  it('dry-run writes nothing (incl. under --system-root) but prints the unit text', async () => {
    const root = await tempRoot()
    const out = await captureStdout(() => runInstall(installOptions({
      mode: 'systemd',
      dryRun: true,
      appDir: join(root, 'app'),
      dataDir: join(root, 'data'),
      systemRoot: root,
    })))
    expect(existsSync(join(root, 'etc'))).toBe(false)
    expect(out).toContain('[Unit]')
    expect(out).toContain('ExecStart=')
  }, 120_000)

  it('creates <app-dir>/bin/dsh-multiuser as a symlink to the CLI entry', async () => {
    const root = await tempRoot()
    await runSystemdInstall(root)
    const link = join(root, 'app', 'bin', 'dsh-multiuser')
    const stat = await lstat(link)
    expect(stat.isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe('../dist/src/cli.js')
    const target = join(root, 'app', 'dist/src/cli.js')
    expect(existsSync(target)).toBe(true)
    expect((statSync(target).mode & 0o111) !== 0).toBe(true)
  }, 120_000)

  it('keeps the committed deploy/ sample in sync with the generated unit', async () => {
    // The sample in deploy/ used to be hand-maintained and drifted far enough to
    // be unusable (a Harness source checkout the production manual forbids, a
    // /srv layout, and a stale --allowed-host line outside ExecStart). Lock it to
    // the generator: comments may differ, executable directives may not.
    const output = await captureStdout(async () => {
      await runInstall(installOptions({
        mode: 'systemd',
        dryRun: true,
        appDir: '/opt/dsh-multiuser',
        dataDir: '/var/lib/dsh-multiuser',
        dshCommand: '/usr/local/bin/dsh',
        host: '127.0.0.1',
        port: '18088',
        allowedHost: 'dsh.example.com',
        serviceUser: 'dsh-multiuser',
      }))
    })
    const marker = 'systemd unit:\n'
    const start = output.indexOf(marker)
    expect(start).toBeGreaterThanOrEqual(0)
    const generated = output.slice(start + marker.length)

    const sample = await readFile(join(packageRoot(), 'deploy/dsh-multiuser.service'), 'utf8')
    const directives = (unit: string): string[] => unit
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'))
    expect(directives(sample)).toEqual(directives(generated))
  }, 120_000)
})

// The gateway is plain HTTP; a dotted host (e.g. an internal DNS name like
// `gateway.internal`) must still be probed over HTTP, never HTTPS. This resolves a
// dotted loopback name once so the regression test below runs only where such a
// name is reachable (it is on the macOS dev host). Skipping elsewhere keeps the
// suite deterministic without depending on every environment's /etc/hosts.
const dottedLoopbackResolves = await lookup('localhost.localdomain').then(result => result.address === '127.0.0.1').catch(() => false)

describe('status health endpoints', () => {
  it('reports healthz/readyz failures and admin state from a temp server', async () => {
    const root = await tempRoot()
    const db = join(root, 'gateway.sqlite')
    const server = createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200)
        res.end('ok')
      } else if (req.url === '/readyz') {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ checks: [{ code: 'SQLITE', ok: false, detail: '/var/lib/dsh-multiuser/gateway.sqlite not writable' }] }))
      } else if (req.url === '/version') {
        res.writeHead(200)
        res.end('0.1.0')
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>(resolve => { server.listen(0, resolve) })
    const port = String((server.address() as AddressInfo).port)
    const out = await captureStdout(() => runStatus({
      db,
      dataRoot: join(root, 'users'),
      dshCommand: 'node',
      dshArgs: '[]',
      profile: 'user-runtime',
      profileSource: join(packageRoot(), 'profiles/user-runtime'),
      host: '127.0.0.1',
      port,
    }))
    // readyz is 503 (not ready) so the command must report a non-zero exit code.
    const exitCode = process.exitCode ?? 0
    process.exitCode = undefined
    server.close()
    expect(out).toContain('healthz: ok')
    expect(out).toContain('SQLITE: /var/lib/dsh-multiuser/gateway.sqlite not writable')
    expect(out).toContain('admin account:')
    expect(exitCode).toBe(1)
  }, 30_000)

  // Regression for the bug where `--host-header` was a no-op: Node's `fetch`
  // (undici) silently drops the forbidden `Host` header, so a gateway enforcing a
  // trusted-Host allow-list kept answering 421 no matter what. We probe a local
  // server that mimics that allow-list (421 unless Host === the trusted name) and
  // assert that the probe honors `--host-header` (ok + exit 0) while a missing or
  // wrong Host still yields 421 + non-zero exit — without any real gateway, DSH,
  // or database.
  it('honors --host-header against a Host allow-list and fails on 421/503', async () => {
    const root = await tempRoot()
    const db = join(root, 'gateway.sqlite')
    const trusted = 'dsh.example.com'
    const server = createServer((req, res) => {
      if (req.headers.host !== trusted) {
        res.writeHead(421, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'host not allowed', received: req.headers.host }))
        return
      }
      if (req.url === '/readyz') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ready', checks: [] }))
      } else if (req.url === '/version') {
        res.writeHead(200)
        res.end('0.1.0')
      } else {
        res.writeHead(200)
        res.end(JSON.stringify({ status: 'ok' }))
      }
    })
    await new Promise<void>(resolve => { server.listen(0, resolve) })
    const port = String((server.address() as AddressInfo).port)
    const baseStatus = {
      db,
      dataRoot: join(root, 'users'),
      dshCommand: 'node',
      dshArgs: '[]',
      profile: 'user-runtime',
      profileSource: join(packageRoot(), 'profiles/user-runtime'),
      host: '127.0.0.1',
      port,
    }
    // WITH --host-header: the probe sends Host: <trusted>, the allow-list accepts,
    // both endpoints return 200, and the command exits 0.
    const withit = await captureStdout(() => runStatus({ ...baseStatus, hostHeader: trusted }))
    const withExit = process.exitCode ?? 0
    process.exitCode = undefined
    expect(withit).toContain('healthz: ok')
    expect(withit).toContain('readyz: ready')
    expect(withExit).toBe(0)
    // WITHOUT --host-header: the probe's Host is 127.0.0.1:<port>, the allow-list
    // rejects it with 421, and the command must exit non-zero.
    const without = await captureStdout(() => runStatus(baseStatus))
    const withoutExit = process.exitCode ?? 0
    process.exitCode = undefined
    server.close()
    expect(without).toContain('healthz: unexpected status 421')
    expect(without).toContain('readyz: rejected by Host allow-list')
    expect(withoutExit).toBe(1)
  }, 30_000)

  // Regression for the https-guessing bug: a dotted host is NOT a signal to use
  // TLS. The gateway is plain HTTP (TLS terminated upstream), so `status` must
  // always probe over HTTP even for a hostname like `localhost.localdomain`. If it
  // wrongly upgraded to HTTPS the probe would fail the TLS handshake against a
  // plaintext port and report `unreachable` — a misleading error. Skipped where
  // the dotted loopback name is unreachable.
  it.skipIf(!dottedLoopbackResolves)('probes a dotted hostname over HTTP (no https guess)', async () => {
    const root = await tempRoot()
    const db = join(root, 'gateway.sqlite')
    const trusted = 'dsh.example.com'
    const server = createServer((req, res) => {
      // Accept any Host here (the allow-list is exercised by the other test); we
      // only care that the TCP connection + plaintext HTTP actually succeeds.
      if (req.url === '/readyz') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ready', checks: [] }))
      } else {
        res.writeHead(200)
        res.end(JSON.stringify({ status: 'ok' }))
      }
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const port = String((server.address() as AddressInfo).port)
    const out = await captureStdout(() => runStatus({
      db,
      dataRoot: join(root, 'users'),
      dshCommand: 'node',
      dshArgs: '[]',
      profile: 'user-runtime',
      profileSource: join(packageRoot(), 'profiles/user-runtime'),
      host: 'localhost.localdomain',
      port,
      hostHeader: trusted,
    }))
    const exitCode = process.exitCode ?? 0
    process.exitCode = undefined
    server.close()
    expect(out).toContain('healthz: ok')
    expect(out).toContain('readyz: ready')
    expect(exitCode).toBe(0)
  }, 30_000)
})
