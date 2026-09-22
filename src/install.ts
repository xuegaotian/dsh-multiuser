import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { AuthStore } from './auth-local.js'
import { runDshCommand, type DshCommandOptions } from './profile-install.js'
import { prepareUserProfile } from './user-profile.js'

/**
 * Package root directory. Resolves for both execution layouts: the published
 * tree (dist/src/install.js, two levels under the root) and the development
 * checkout (src/install.ts, one level under the root).
 */
export function packageRoot(): string {
  const fromDist = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  if (existsSync(join(fromDist, 'package.json'))) return fromDist
  const fromSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  if (existsSync(join(fromSrc, 'package.json'))) return fromSrc
  throw new Error(`could not locate the dsh-multiuser package root from ${import.meta.url}`)
}

export interface CheckResult {
  code: string
  ok: boolean
  detail: string
}

const NODE_ENGINE_PATTERN = /^\^22\.19\.0 \|\| >=24\.0\.0$/u

function nodeVersionOk(version: string): boolean {
  const match = /^v(\d+)\.(\d+)\.(\d+)/u.exec(version)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major < 22) return false
  if (major === 22) return minor >= 19
  return true
}

async function dshVersion(command: string, args: readonly string[], cwd?: string): Promise<string | undefined> {
  return await new Promise<string | undefined>(resolvePromise => {
    const child = spawn(command, [...args, '--version'], { cwd: cwd ?? process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.once('error', () => resolvePromise(undefined))
    child.once('close', () => {
      const match = /\d+\.\d+\.\d+[-a-zA-Z0-9.]*/u.exec(output.trim())
      resolvePromise(match === null ? undefined : match[0])
    })
  })
}

export interface DoctorOptions {
  dshCommand: string
  dshArgs: string
  dshCwd?: string | undefined
  db: string
  dataRoot: string
  profile: string
  profileSource: string
  ssoPublicKey?: string[] | undefined
  ssoIssuer?: string | undefined
  ssoAudience?: string | undefined
  ssoOrigin?: string | undefined
  insecureCookies?: boolean | undefined
  json?: boolean | undefined
}

/** Read-only environment check. Never creates files, runs servers, or mutates state. */
export async function runDoctor(options: DoctorOptions): Promise<{ ok: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = []
  const push = (code: string, ok: boolean, detail: string): void => { results.push({ code, ok, detail }) }

  // 1. Node engine
  const nodeVersion = process.version
  push('NODE_VERSION', nodeVersionOk(nodeVersion), `node ${nodeVersion} (requires ^22.19.0 || >=24.0.0)`)

  // 2. DSH presence and exact version
  let dshArgs: readonly string[] = []
  try {
    const parsed: unknown = JSON.parse(options.dshArgs)
    if (Array.isArray(parsed) && parsed.every(value => typeof value === 'string')) dshArgs = parsed as string[]
  } catch { /* handled below */ }
  push('DSH_ARGS', dshArgs.length === 0 || Array.isArray(dshArgs), options.dshArgs === '[]' ? 'no launcher prefix arguments' : `launcher prefix arguments: ${options.dshArgs}`)
  const version = await dshVersion(options.dshCommand, dshArgs, options.dshCwd)
  if (version === undefined) {
    push('DSH_VERSION', false, `could not execute ${options.dshCommand} --version`)
  } else {
    // 3. Compatibility list
    const compatibility = await readCompatibility()
    const supported = compatibility.testedDshVersions.includes(version)
    const canary = compatibility.canaryDshVersions.includes(version)
    push('DSH_VERSION', true, `dsh ${version}`)
    push('DSH_COMPATIBILITY', supported, supported
      ? `dsh ${version} is a tested version (compatibility.json)`
      : canary
        ? `dsh ${version} is a canary version (verified forward-looking, not a release blocker)`
        : `dsh ${version} is NOT in compatibility.json tested=${JSON.stringify(compatibility.testedDshVersions)} canary=${JSON.stringify(compatibility.canaryDshVersions)}`)
  }

  // 4. Paths: existence and permissions
  const dbPath = resolve(options.db)
  const dbExists = existsSync(dbPath)
  push('DB_PATH', true, `database: ${dbPath}${dbExists ? ' (exists)' : ' (not created yet)'}`)
  if (dbExists) {
    const mode = statMode(dbPath)
    const unsafe = (mode & 0o077) !== 0
    push('DB_PERMISSION', !unsafe, `database permissions ${modeToString(mode)}${unsafe ? ' — group/other access present; run chmod 0600' : ''}`)
  }
  const dataRootPath = resolve(options.dataRoot)
  if (existsSync(dataRootPath)) {
    const mode = statMode(dataRootPath)
    const unsafe = (mode & 0o077) !== 0
    push('DATA_ROOT', true, `data root: ${dataRootPath}`)
    push('DATA_PERMISSION', !unsafe, `data root permissions ${modeToString(mode)}${unsafe ? ' — group/other access present; run chmod 0700' : ''}`)
  } else push('DATA_ROOT', true, `data root: ${dataRootPath} (not created yet)`)

  // 5. Profile source
  const profileSourcePath = resolve(options.profileSource)
  push('PROFILE_SOURCE', existsSync(join(profileSourcePath, 'package.json')), `profile source: ${profileSourcePath}`)

  // 6. Profile composition via dump-config (read-only, uses an isolated temp home)
  if (existsSync(join(profileSourcePath, 'package.json')) && version !== undefined) {
    try {
      const probe = await mkdtemp(join(tmpdir(), 'dsh-multiuser-doctor-'))
      try {
        await prepareUserProfile(profileSourcePath, join(probe, 'home'))
        await runDshCommand({ command: options.dshCommand, args: dshArgs, home: join(probe, 'home'), ...(options.dshCwd === undefined ? {} : { cwd: options.dshCwd }) }, ['--profile', options.profile, '--dump-config'])
        push('PROFILE_COMPOSITION', true, `profile ${options.profile} composes through dsh --dump-config`)
      } finally {
        await rm(probe, { recursive: true, force: true })
      }
    } catch (error) {
      push('PROFILE_COMPOSITION', false, `profile composition failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 7. SSO all-or-nothing
  const ssoValues = [options.ssoPublicKey, options.ssoIssuer, options.ssoAudience, options.ssoOrigin]
  const ssoConfigured = ssoValues.filter(value => value !== undefined).length
  if (ssoConfigured === 0) push('SSO_CONFIG', false, 'no SSO options given — SSO sign-in will be unavailable (ordinary users cannot log in)')
  else if (ssoConfigured === 4) {
    let keysOk = true
    let keyDetail = ''
    for (const entry of options.ssoPublicKey ?? []) {
      const separator = entry.indexOf('=')
      const path = separator < 1 ? undefined : entry.slice(separator + 1)
      if (path === undefined || !existsSync(path)) { keysOk = false; keyDetail = `public key file missing: ${path ?? entry}`; break }
    }
    push('SSO_CONFIG', keysOk, keysOk ? `SSO fully configured (${String(options.ssoPublicKey?.length ?? 0)} key(s), issuer ${String(options.ssoIssuer)})` : keyDetail)
  } else push('SSO_CONFIG', false, `SSO options are incomplete (${String(ssoConfigured)}/4) — all of --sso-public-key, --sso-issuer, --sso-audience, --sso-origin are required when SSO is enabled`)

  // 8. Secure cookies warning
  if (options.insecureCookies === true) push('SECURE_COOKIES', false, '--insecure-cookies is set — acceptable for local HTTP development only, never for production')

  const ok = results.every(result => result.ok)
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok, results })}\n`)
  } else {
    for (const result of results) process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.code}: ${result.detail}\n`)
    process.stdout.write(ok ? 'doctor: all checks passed\n' : 'doctor: one or more checks failed\n')
  }
  return { ok, results }
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777
}

function modeToString(mode: number): string {
  return `0${mode.toString(8)}`
}

export async function readCompatibility(): Promise<{ testedDshVersions: string[]; canaryDshVersions: string[]; node: string }> {
  const path = join(packageRoot(), 'compatibility.json')
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { testedDshVersions?: string[]; canaryDshVersions?: string[]; node?: string }
  if (!Array.isArray(parsed.testedDshVersions) || !Array.isArray(parsed.canaryDshVersions)) throw new Error(`compatibility.json is malformed: ${path}`)
  return { testedDshVersions: parsed.testedDshVersions, canaryDshVersions: parsed.canaryDshVersions, node: parsed.node ?? NODE_ENGINE_PATTERN.source }
}

export interface InstallOptions {
  mode: 'local' | 'systemd'
  dryRun: boolean
  appDir: string
  dataDir: string
  dshCommand: string
  dshArgs: string
  dshCwd?: string | undefined
  profile: string
  profileSource: string
  host: string
  port: string
  allowedHost?: string | undefined
  ssoPublicKey?: string[] | undefined
  ssoIssuer?: string | undefined
  ssoAudience?: string | undefined
  ssoOrigin?: string | undefined
  serviceUser: string
  insecureCookies?: boolean | undefined
  /** Staging root for system paths. Empty string means the real filesystem root `/`. */
  systemRoot: string
}

export interface InstallPlan {
  mode: 'local' | 'systemd'
  appDir: string
  dataDir: string
  dbPath: string
  dataRoot: string
  profileSource: string
  bundleTarget: string
  serviceFile?: string
  envFile?: string
  gatewayArgs: string[]
  steps: string[]
}

/** Compute the install plan without touching the filesystem. */
export function planInstall(options: InstallOptions): InstallPlan {
  const appDir = resolve(options.appDir)
  const dataDir = resolve(options.dataDir)
  const dbPath = join(dataDir, 'gateway.sqlite')
  const dataRoot = join(dataDir, 'users')
  const profileSource = join(appDir, 'profiles/user-runtime')
  const bundleTarget = join(appDir, 'packages/bundle/user-runtime')
  const steps: string[] = []
  steps.push(`copy application files to ${appDir}`)
  steps.push(`create data directory ${dataDir} (mode 0700)`)
  if (options.mode === 'systemd') {
    steps.push(`write service unit ${systemdServicePath(options.systemRoot)}`)
    steps.push(`write environment file ${systemdEnvPath(options.systemRoot)} (mode 0600, never overwritten)`)
    steps.push(`create keys directory ${systemdKeysPath(options.systemRoot)} (mode 0750)`)
    steps.push(`create dedicated service account ${options.serviceUser}`)
  }
  steps.push(`create launcher entry ${join(appDir, 'bin/dsh-multiuser')}`)
  steps.push(`prepare template profile home under ${join(dataRoot, 'profile-template')}`)
  steps.push(`run doctor to verify the installation`)
  const gatewayArgs = ['--db', dbPath, '--data-root', dataRoot, '--dsh-command', options.dshCommand, '--dsh-args', options.dshArgs, '--profile', options.profile, '--profile-source', profileSource, '--host', options.host, '--port', options.port, ...(options.allowedHost === undefined ? [] : ['--allowed-host', options.allowedHost]), ...(options.ssoPublicKey === undefined ? [] : ['--sso-public-key', ...options.ssoPublicKey]), ...(options.ssoIssuer === undefined ? [] : ['--sso-issuer', options.ssoIssuer]), ...(options.ssoAudience === undefined ? [] : ['--sso-audience', options.ssoAudience]), ...(options.ssoOrigin === undefined ? [] : ['--sso-origin', options.ssoOrigin]), ...(options.insecureCookies === true ? ['--insecure-cookies'] : [])]
  return {
    mode: options.mode,
    appDir,
    dataDir,
    dbPath,
    dataRoot,
    profileSource,
    bundleTarget,
    ...(options.mode === 'systemd' ? { serviceFile: systemdServicePath(options.systemRoot), envFile: systemdEnvPath(options.systemRoot) } : {}),
    gatewayArgs,
    steps,
  }
}

const SYSTEMD_SERVICE_PATH = '/etc/systemd/system/dsh-multiuser.service'
const SYSTEMD_ENV_PATH = '/etc/dsh-multiuser/gateway.env'

/** Absolute path of the systemd unit, prefixed by `systemRoot` when staging. */
export function systemdServicePath(systemRoot: string): string {
  return systemRoot === '' ? SYSTEMD_SERVICE_PATH : join(systemRoot, SYSTEMD_SERVICE_PATH.slice(1))
}

/** Absolute path of the gateway environment file, prefixed by `systemRoot`. */
export function systemdEnvPath(systemRoot: string): string {
  return systemRoot === '' ? SYSTEMD_ENV_PATH : join(systemRoot, SYSTEMD_ENV_PATH.slice(1))
}

/** Absolute path of the SSO keys directory, derived from the environment path. */
export function systemdKeysPath(systemRoot: string): string {
  return join(dirname(systemdEnvPath(systemRoot)), 'keys')
}

/**
 * Build the systemd unit. SSO flags are emitted only when all four are present,
 * one `--sso-public-key` per line (each continued with `\`), and `--allowed-host`
 * is always the final argument line (no continuation). Command-line secrets are
 * never used: `--insecure-cookies` is intentionally absent from the unit.
 */
function systemdUnit(plan: InstallPlan, options: InstallOptions): string {
  const gatewayArgs: string[] = [
    `--db ${plan.dbPath}`,
    `--data-root ${plan.dataRoot}`,
    `--dsh-command ${options.dshCommand}`,
    `--dsh-args '${options.dshArgs}'`,
    `--profile ${options.profile}`,
    `--profile-source ${plan.profileSource}`,
    `--host ${options.host}`,
    `--port ${options.port}`,
  ]
  const ssoComplete = options.ssoPublicKey !== undefined && options.ssoIssuer !== undefined && options.ssoAudience !== undefined && options.ssoOrigin !== undefined
  if (ssoComplete) {
    for (const key of options.ssoPublicKey ?? []) gatewayArgs.push(`--sso-public-key ${key}`)
    gatewayArgs.push(`--sso-issuer ${options.ssoIssuer}`)
    gatewayArgs.push(`--sso-audience ${options.ssoAudience}`)
    gatewayArgs.push(`--sso-origin ${options.ssoOrigin}`)
  }
  // --allowed-host is appended last so the shared continuation logic keeps it
  // inside ExecStart (never a dangling line) and it ends without a backslash.
  gatewayArgs.push(`--allowed-host ${options.allowedHost ?? `${options.host}:${options.port}`}`)
  // Every argument line except the last carries a backslash continuation.
  const argLines = gatewayArgs.map((arg, index) => `  ${arg}${index < gatewayArgs.length - 1 ? ' \\' : ''}`)
  return `[Unit]
Description=DSH Multi-user Gateway
After=network.target

[Service]
Type=simple
User=${options.serviceUser}
Group=${options.serviceUser}
WorkingDirectory=${plan.appDir}
EnvironmentFile=${SYSTEMD_ENV_PATH}
ExecStart=/usr/bin/node ${plan.appDir}/dist/src/gateway-cli.js \\
${argLines.join('\n')}
Restart=on-failure
RestartSec=5s
UMask=0077
KillMode=control-group

[Install]
WantedBy=multi-user.target
`
}

/** Idempotent install: never overwrite accounts, keys, or user Profile content. */
export async function runInstall(options: InstallOptions): Promise<void> {
  const plan = planInstall(options)
  if (options.dryRun) {
    process.stdout.write(`install plan (${options.mode} mode, dry run — nothing will be modified)\n`)
    for (const step of plan.steps) process.stdout.write(`  - ${step}\n`)
    process.stdout.write(`gateway arguments: ${plan.gatewayArgs.join(' ')}\n`)
    if (options.mode === 'systemd') {
      process.stdout.write('systemd unit:\n')
      process.stdout.write(systemdUnit(plan, options))
    }
    return
  }
  // systemd writes to /etc and must run as root (unless a staging --system-root
  // is given for previewing on a non-root host). Fail fast before any work.
  if (options.mode === 'systemd' && options.systemRoot === '' && process.getuid?.() !== 0) {
    const { name, version } = readPackageNameVersion()
    throw new Error(`systemd installation writes to ${SYSTEMD_SERVICE_PATH} and must run as root. Re-run with sudo:\n  sudo npx ${name}@${version} install --mode systemd --app-dir ${plan.appDir} --data-dir ${plan.dataDir}${options.profileSource === '' ? '' : ` --profile-source ${options.profileSource}`}\nOr preview the plan without modifying anything:\n  npx ${name}@${version} install --mode systemd --dry-run`)
  }
  // 1. Resolve all target paths (absolute)
  // 2. Check for existing user data (preserve!)
  const existingDb = existsSync(plan.dbPath)
  // 3. Stage a complete file tree in a temporary directory
  const staging = await mkdtemp(join(tmpdir(), 'dsh-multiuser-install-'))
  try {
    const stagedApp = join(staging, 'app')
    await copyAppTree(stagedApp)
    // Install production dependencies in the staged tree so the installed app
    // runs without the development checkout or a global node_modules.
    await runNpmInstall(stagedApp)
    // 4. Run profile installation and dump-config verification in the staged tree
    const stagedProfile = join(stagedApp, 'profiles/user-runtime')
    await prepareUserProfile(stagedProfile, join(staging, 'probe-home'))
    const dshArgs = parseDshArgs(options.dshArgs)
    await runDshCommand({ command: options.dshCommand, args: dshArgs, home: join(staging, 'probe-home'), ...(options.dshCwd === undefined ? {} : { cwd: options.dshCwd }) }, ['--profile', options.profile, '--dump-config'])
    // 5. Atomically replace the app directory, preserving the data directory
    await mkdir(dirname(plan.appDir), { recursive: true })
    const previous = `${plan.appDir}.previous`
    if (existsSync(plan.appDir)) {
      await rm(previous, { recursive: true, force: true })
      await rename(plan.appDir, previous)
    }
    try {
      await rename(stagedApp, plan.appDir)
      // 6. Data directory
      await mkdir(plan.dataDir, { recursive: true })
      await chmod(plan.dataDir, 0o700).catch(() => undefined)
      // 7. Stable launcher entry, required by both local and systemd operation.
      await createBinEntry(plan.appDir)
      // 8. Verify the installed paths, runtime compatibility, Profile, and SSO
      //    configuration before discarding the previous application tree.
      const doctor = await runDoctor({
        dshCommand: options.dshCommand,
        dshArgs: options.dshArgs,
        ...(options.dshCwd === undefined ? {} : { dshCwd: options.dshCwd }),
        db: plan.dbPath,
        dataRoot: plan.dataRoot,
        profile: options.profile,
        profileSource: plan.profileSource,
        ...(options.ssoPublicKey === undefined ? {} : { ssoPublicKey: doctorSsoPublicKeys(options.ssoPublicKey, options.systemRoot) }),
        ...(options.ssoIssuer === undefined ? {} : { ssoIssuer: options.ssoIssuer }),
        ...(options.ssoAudience === undefined ? {} : { ssoAudience: options.ssoAudience }),
        ...(options.ssoOrigin === undefined ? {} : { ssoOrigin: options.ssoOrigin }),
        ...(options.insecureCookies === undefined ? {} : { insecureCookies: options.insecureCookies }),
      })
      if (!doctor.ok) throw new Error('installed application failed doctor checks')
      // 9. systemd mode: write the unit, the (once-only) environment file, the
      //    keys directory, and create the dedicated service account.
      if (options.mode === 'systemd') await installSystemd(plan, options)
      if (existsSync(previous)) await rm(previous, { recursive: true, force: true })
    } catch (error) {
      await rm(plan.appDir, { recursive: true, force: true })
      if (existsSync(previous)) await rename(previous, plan.appDir)
      throw error
    }
    // 10. First install only: no admin initialization here — the admin account is
    //     created by `init-admin` which refuses to run twice; state the fact.
    if (existingDb) process.stdout.write(`database already exists at ${plan.dbPath} — accounts and sessions preserved\n`)
    else process.stdout.write(`database not present at ${plan.dbPath} — run init-admin to create the first administrator\n`)
    process.stdout.write(`installed to ${plan.appDir}\n`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

function doctorSsoPublicKeys(entries: string[], systemRoot: string): string[] {
  if (systemRoot === '') return entries
  return entries.map(entry => {
    const separator = entry.indexOf('=')
    if (separator < 1) return entry
    const path = entry.slice(separator + 1)
    if (!isAbsolute(path) || path === systemRoot || path.startsWith(`${systemRoot}/`)) return entry
    return `${entry.slice(0, separator + 1)}${join(systemRoot, path.slice(1))}`
  })
}

/** Create `<appDir>/bin/dsh-multiuser` as a relative symlink to the CLI entry. */
async function createBinEntry(appDir: string): Promise<void> {
  const binDir = join(appDir, 'bin')
  await mkdir(binDir, { recursive: true })
  const link = join(binDir, 'dsh-multiuser')
  const target = '../dist/src/cli.js'
  try {
    const current = await readlink(link)
    if (current === target) return
    await unlink(link)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await symlink(target, link)
}

const ENV_FILE_HEADER = `# dsh-multiuser gateway environment file
# Loaded by systemd via EnvironmentFile=; secrets are never passed on the command line.
# This file is mode 0600 and created once. It is never overwritten on upgrade so that
# operator-supplied provider keys are preserved. Fill in the placeholders below.

DEEPSEEK_API_KEY=
`

/** Write the systemd unit, the (once-only) environment file, and the keys directory. */
async function installSystemd(plan: InstallPlan, options: InstallOptions): Promise<void> {
  const unitPath = systemdServicePath(options.systemRoot)
  const envPath = systemdEnvPath(options.systemRoot)
  const keysPath = systemdKeysPath(options.systemRoot)
  // Unit: regenerated from the current arguments on every install.
  await mkdir(dirname(unitPath), { recursive: true })
  await writeFile(unitPath, systemdUnit(plan, options))
  process.stdout.write(`service unit written to ${unitPath}\n`)
  if (options.systemRoot === '') {
    process.stdout.write(`enable and start: sudo systemctl daemon-reload && sudo systemctl enable --now dsh-multiuser\n`)
  } else {
    // When staging, the unit references the real /etc paths, so the install
    // commands must copy both the unit and the env file (and create the keys
    // dir) — otherwise EnvironmentFile would point at a missing file.
    process.stdout.write(`staged at ${unitPath}\n`)
    process.stdout.write(`install on the target host with:\n`)
    process.stdout.write(`  sudo cp ${unitPath} ${SYSTEMD_SERVICE_PATH}\n`)
    process.stdout.write(`  sudo cp ${envPath} ${SYSTEMD_ENV_PATH}\n`)
    process.stdout.write(`  sudo install -d -o root -g dsh-multiuser -m 0750 ${keysPath}\n`)
    process.stdout.write(`  sudo systemctl daemon-reload && sudo systemctl enable --now dsh-multiuser\n`)
  }
  // Environment file: create once, never overwrite (may hold operator secrets).
  await mkdir(dirname(envPath), { recursive: true })
  await chmod(dirname(envPath), 0o755).catch(() => undefined)
  if (existsSync(envPath)) {
    process.stdout.write(`environment file already exists at ${envPath} — not overwriting (preserve operator secrets)\n`)
  } else {
    await writeFile(envPath, ENV_FILE_HEADER, { mode: 0o600 })
    await chmod(envPath, 0o600).catch(() => undefined)
    process.stdout.write(`environment file written to ${envPath} (mode 0600)\n`)
  }
  // Keys directory for SSO public keys.
  await mkdir(keysPath, { recursive: true })
  await chmod(keysPath, 0o750).catch(() => undefined)
  process.stdout.write(`keys directory ready at ${keysPath} (mode 0750)\n`)
  // Service account (real host only; staging skips it and prints the command).
  await ensureServiceAccount(options.serviceUser, options.systemRoot)
}

/** Create the dedicated systemd service account, or print the command to do so. */
async function ensureServiceAccount(serviceUser: string, systemRoot: string): Promise<void> {
  const command = `sudo useradd --system --home-dir /var/lib/dsh-multiuser --shell /usr/sbin/nologin ${serviceUser}`
  if (systemRoot !== '') {
    process.stdout.write(`staging into --system-root ${systemRoot}: skip service account creation; on the target host run:\n  ${command}\n`)
    return
  }
  if (process.getuid?.() !== 0) {
    process.stdout.write(`not running as root: skip service account creation; run:\n  ${command}\n`)
    return
  }
  const useradd = await whichCommand('useradd')
  if (useradd === undefined) {
    process.stdout.write(`useradd not found: create the service account manually:\n  ${command}\n`)
    return
  }
  try {
    await execCommand('id', ['-u', serviceUser])
    process.stdout.write(`service account ${serviceUser} already exists\n`)
  } catch {
    await execCommand('useradd', ['--system', '--home-dir', '/var/lib/dsh-multiuser', '--shell', '/usr/sbin/nologin', serviceUser])
    process.stdout.write(`created service account ${serviceUser}\n`)
  }
}

function whichCommand(command: string): Promise<string | undefined> {
  const shell = process.platform === 'win32' ? 'cmd' : 'sh'
  const arg = process.platform === 'win32' ? `/c where ${command}` : `-c command -v ${command}`
  return new Promise(resolvePromise => {
    const child = spawn(shell, [arg], { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.once('error', () => resolvePromise(undefined))
    child.once('close', code => resolvePromise(code === 0 ? output.trim().split('\n')[0] : undefined))
  })
}

function execCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} failed (exit ${String(code)}): ${output.slice(-1_000)}`))
    })
  })
}

function readPackageNameVersion(): { name: string; version: string } {
  const manifest = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { name?: string; version?: string }
  return { name: manifest.name ?? 'dsh-multiuser', version: manifest.version ?? '0.0.0' }
}

/** Install production dependencies of the staged application tree. */
function runNpmInstall(directory: string): Promise<void> {
  // Skip when a dependency tree is already present (copied from the checkout or
  // a pre-staged package); this keeps installs offline and fast.
  if (existsSync(join(directory, 'node_modules'))) return Promise.resolve()
  return new Promise((resolvePromise, reject) => {
    const child = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`npm install failed (exit ${String(code)}): ${output.slice(-1_000)}`))
    })
  })
}

function parseDshArgs(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string')) throw new Error('--dsh-args must be a JSON string array')
  return parsed as string[]
}

/** Copy the published application tree (dist, profiles, packages, deploy, metadata). */
export async function copyAppTree(target: string): Promise<void> {
  const root = packageRoot()
  await mkdir(target, { recursive: true })
  await cp(join(root, 'dist/src'), join(target, 'dist/src'), { recursive: true })
  await cp(join(root, 'profiles'), join(target, 'profiles'), { recursive: true })
  await cp(join(root, 'packages'), join(target, 'packages'), { recursive: true })
  for (const file of ['compatibility.json', 'README.md', 'LICENSE']) {
    if (existsSync(join(root, file))) await cp(join(root, file), join(target, file))
  }
  if (existsSync(join(root, 'deploy'))) await cp(join(root, 'deploy'), join(target, 'deploy'), { recursive: true })
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
  // The installed app tree exists only to run prebuilt output; it never builds.
  // `prepare` is a source-install hook, so carrying it into the deployed app
  // would make a later `npm install` there try to run tsc over absent sources.
  const scripts = { ...(manifest.scripts as Record<string, string> | undefined) }
  delete scripts.prepare
  await writeFile(join(target, 'package.json'), `${JSON.stringify({ ...manifest, scripts, devDependencies: undefined }, undefined, 2)}\n`)
  await chmod(join(target, 'dist/src/cli.js'), 0o755).catch(() => undefined)
}

/** Uninstall: stop the service, remove app files, and keep data unless --purge-data. */
export async function runUninstall(appDir: string, dataDir: string, purgeData: boolean, dryRun: boolean): Promise<void> {
  const appPath = resolve(appDir)
  const dataPath = resolve(dataDir)
  const steps: string[] = []
  steps.push(`remove application directory ${appPath}`)
  if (purgeData) steps.push(`remove data directory ${dataPath} (purge)`)
  else steps.push(`keep data directory ${dataPath} (default)`)
  if (dryRun) {
    process.stdout.write('uninstall plan (dry run — nothing will be modified)\n')
    for (const step of steps) process.stdout.write(`  - ${step}\n`)
    return
  }
  if (purgeData) {
    const dangerous = [dataPath, appPath].some(path => path === '/' || path === process.env.HOME || path === process.cwd())
    if (dangerous) throw new Error(`refusing to purge ${dataPath}: refusing root, user home, or working directory`)
    await rm(dataPath, { recursive: true, force: true })
  }
  await rm(appPath, { recursive: true, force: true })
  process.stdout.write(purgeData ? `removed ${appPath} and ${dataPath}\n` : `removed ${appPath}; data preserved at ${dataPath}\n`)
}

export interface ServiceControlOptions {
  db: string
  dataRoot: string
  dshCommand: string
  dshArgs: string
  profile: string
  profileSource: string
  host: string
  port: string
  allowedHost?: string | undefined
  insecureCookies?: boolean | undefined
}

/** Build the gateway argv for start/status helpers. */
export function gatewayArgv(options: ServiceControlOptions): string[] {
  return ['--db', resolve(options.db), '--data-root', resolve(options.dataRoot), '--dsh-command', options.dshCommand, '--dsh-args', options.dshArgs, '--profile', options.profile, '--profile-source', resolve(options.profileSource), '--host', options.host, '--port', options.port, ...(options.allowedHost === undefined ? [] : ['--allowed-host', options.allowedHost]), ...(options.insecureCookies === true ? ['--insecure-cookies'] : [])]
}

/**
 * Probe a single gateway health endpoint over HTTP.
 *
 * We use `node:http` directly rather than `fetch` on purpose: Node's `fetch`
 * (undici) treats `Host` as a forbidden header and silently drops it, so a
 * caller-supplied `Host` (e.g. `--host-header`) would never reach the gateway. The
 * gateway enforces a trusted-Host allow-list (`--allowed-host`) and answers 421
 * otherwise, so the probe must set `Host` explicitly.
 *
 * The gateway is plain HTTP only (TLS is terminated upstream, e.g. by Nginx); the
 * probe therefore always uses `node:http` and never guesses a scheme from the host
 * shape. The probe never throws: on timeout or connection error it resolves
 * `{ status: 0, body: '' }` so callers can report unreachable.
 */
interface ProbeResult {
  status: number
  body: string
}

function probeEndpoint(host: string, port: string, path: string, hostHeader?: string): Promise<ProbeResult> {
  return new Promise(resolveProbe => {
    const headers: Record<string, string> = {}
    if (hostHeader !== undefined) headers['Host'] = hostHeader
    const request = http.request(
      { host, port: Number(port), path, method: 'GET', headers, timeout: 2000 },
      response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => resolveProbe({ status: response.statusCode ?? 0, body }))
      }
    )
    request.on('timeout', () => request.destroy(new Error('probe timed out')))
    request.on('error', () => resolveProbe({ status: 0, body: '' }))
    request.end()
  })
}

/** Parse the `readyz` failure body into its per-check results, ignoring malformed input. */
function parseChecks(body: string): CheckResult[] {
  let parsed: { checks?: unknown } | undefined
  try {
    parsed = JSON.parse(body) as { checks?: unknown }
  } catch {
    return []
  }
  if (!Array.isArray(parsed.checks)) return []
  return parsed.checks.filter(
    (entry): entry is CheckResult => typeof entry === 'object' && entry !== null && 'code' in entry && 'ok' in entry && 'detail' in entry
  )
}

/**
 * Report gateway health using the dedicated endpoints instead of the login page.
 * The login page returning 200 does not prove the full chain (DB, profile
 * template, DSH) is ready, so status probes `/healthz`, `/readyz`, and `/version`.
 *
 * The gateway enforces a trusted-Host allow-list (`--allowed-host`). When the
 * probe host differs from that allow-list the gateway answers 421; pass
 * `--host-header <authority>` to match the configured authority.
 *
 * Exit status: `process.exitCode` stays 0 only when BOTH `/healthz` and `/readyz`
 * return 200. Any other outcome (draining, unexpected status, unreachable, not
 * ready, or Host allow-list rejection) sets it to 1 so orchestration can detect an
 * unhealthy gateway.
 */
export async function runStatus(options: ServiceControlOptions & { hostHeader?: string }): Promise<void> {
  const { host, port, hostHeader } = options
  let healthy = false
  let ready = false
  // /healthz: process accepts HTTP.
  const health = await probeEndpoint(host, port, '/healthz', hostHeader)
  if (health.status === 200) {
    process.stdout.write('healthz: ok\n')
    healthy = true
  } else if (health.status === 503) {
    process.stdout.write('healthz: draining\n')
  } else if (health.status === 0) {
    process.stdout.write('healthz: unreachable (request failed)\n')
  } else {
    process.stdout.write(`healthz: unexpected status ${String(health.status)}\n`)
  }
  // /readyz: ready to accept user traffic.
  const readyProbe = await probeEndpoint(host, port, '/readyz', hostHeader)
  if (readyProbe.status === 200) {
    process.stdout.write('readyz: ready\n')
    ready = true
  } else if (readyProbe.status === 503) {
    process.stdout.write('readyz: not ready\n')
    for (const check of parseChecks(readyProbe.body)) {
      if (!check.ok) process.stdout.write(`  ${check.code}: ${check.detail}\n`)
    }
  } else if (readyProbe.status === 421) {
    process.stdout.write('readyz: rejected by Host allow-list (gateway --allowed-host differs from the probe host); re-run with --host-header <authority>\n')
  } else if (readyProbe.status === 0) {
    process.stdout.write('readyz: unreachable\n')
  } else {
    process.stdout.write(`readyz: unexpected status ${String(readyProbe.status)}\n`)
  }
  // /version: non-sensitive build identity (never fails the command).
  const versionProbe = await probeEndpoint(host, port, '/version', hostHeader)
  if (versionProbe.status >= 200 && versionProbe.status < 300) {
    process.stdout.write(`version: ${versionProbe.body.trim()}\n`)
  }
  // Administrator initialization state.
  const adminExists = checkAdminExists(resolve(options.db))
  process.stdout.write(`admin account: ${adminExists ? 'initialized' : 'not initialized (run init-admin)'}\n`)
  // Healthy only when the gateway accepts traffic on both liveness and readiness.
  if (!healthy || !ready) process.exitCode = 1
}

function checkAdminExists(db: string): boolean {
  if (!existsSync(db)) return false
  const auth = new AuthStore(db)
  try { return auth.listUsers().some(user => user.role === 'admin') } finally { auth.close() }
}

export { SYSTEMD_SERVICE_PATH, SYSTEMD_ENV_PATH, basename }

/** The package version, read from package.json for `--version` output. */
export function packageVersion(): string {
  return readPackageNameVersion().version
}
