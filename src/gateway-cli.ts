import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { AuthStore } from './auth-local.js'
import { Gateway, createReadinessProbe } from './gateway.js'
import { LocalRuntimeProcessProvider, RuntimeManager } from './runtime-manager.js'
import { prepareProfileTemplate, prepareUserProfile } from './user-profile.js'
import { GlobalConfigStore } from './global-config.js'
import { PublicSkillStore } from './public-content.js'
import { PublicMcpStore } from './public-mcp.js'
import { PublicProfileManager } from './public-profile.js'
import { importSPKI } from 'jose'
import { SsoVerifier } from './sso.js'
import { packageRoot, readCompatibility } from './install.js'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(error => error === undefined ? resolve(port) : reject(error))
    })
  })
}

/** Resolve the DSH launcher version without importing the private installer helper. */
function runDshVersionCommand(command: string, args: readonly string[], cwd?: string): Promise<string | undefined> {
  return new Promise<string | undefined>(resolvePromise => {
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

async function readPackageVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(packageRoot(), 'package.json'), 'utf8')) as { version?: string }
    if (typeof pkg.version === 'string') return pkg.version
  } catch { /* fall through to the unknown fallback */ }
  return 'unknown'
}

/**
 * How long a user runtime may take to serve its loopback port before the
 * Gateway gives up on the request that triggered the start.
 *
 * A cold start has to install/refresh the per-user Profile and boot the whole
 * DSH web profile, so the budget has to absorb a loaded host. The previous 5s
 * ceiling (50 attempts) turned a slow boot into an HTTP 500 for the first
 * request of a session, and it also failed under parallel integration runs.
 */
const RUNTIME_HEALTH_CHECK_INTERVAL_MS = 100
const RUNTIME_HEALTH_CHECK_ATTEMPTS = 300

const program = new Command()
  .name('dsh-multiuser gateway')
  .requiredOption('--db <path>', 'SQLite database path')
  .requiredOption('--data-root <path>', 'per-user data root')
  .requiredOption('--dsh-command <command>', 'DSH launcher command')
  .option('--dsh-args <json>', 'JSON array of launcher arguments; source-adapter mode supplies the adapter automatically', '[]')
  .option('--launcher-cwd <path>', 'launcher module-resolution cwd')
  .option('--launcher-entry <path>', 'DSH entry loaded by the runtime launcher adapter')
  .option('--profile <name>', 'DSH profile for each user runtime', 'user-runtime')
  .requiredOption('--profile-source <path>', 'source directory of the versioned user-runtime profile')
  .option('--gateway-env <path>', 'shared model configuration file; defaults beside --db')
  .option('--host <host>', 'gateway bind host', '127.0.0.1')
  .option('--port <port>', 'gateway port', '18088')
  .option('--max-active-runtimes <count>', 'maximum active runtimes', '10')
  .option('--idle-minutes <minutes>', 'idle minutes before runtime collection', '30')
  .option('--allowed-host <authority...>', 'accepted Host authorities')
  .option('--sso-public-key <entry...>', 'SSO public key as kid=/absolute/key.pem')
  .option('--sso-issuer <issuer>', 'required SSO token issuer')
  .option('--sso-audience <audience>', 'required SSO token audience')
  .option('--sso-origin <origin>', 'trusted HTTP(S) origin for SSO form posts')
  .option('--sso-session-minutes <minutes>', 'SSO session lifetime in minutes', '60')
  .option('--insecure-cookies', 'disable Secure cookie for local HTTP development')

try {
  await program.parseAsync()
  const options = program.opts<{
    db: string
    dataRoot: string
    dshCommand: string
    dshArgs: string
    launcherCwd?: string
    launcherEntry?: string
    profile: string
    profileSource: string
    gatewayEnv?: string
    host: '127.0.0.1' | '0.0.0.0'
    port: string
    maxActiveRuntimes: string
    idleMinutes: string
    allowedHost?: string[]
    ssoPublicKey?: string[]
    ssoIssuer?: string
    ssoAudience?: string
    ssoOrigin?: string
    ssoSessionMinutes: string
    insecureCookies?: boolean
  }>()
  const dshArgs: unknown = JSON.parse(options.dshArgs)
  if (!Array.isArray(dshArgs) || !dshArgs.every(value => typeof value === 'string')) throw new Error('--dsh-args must be a JSON string array')
  const ssoValues = [options.ssoPublicKey, options.ssoIssuer, options.ssoAudience, options.ssoOrigin]
  if (ssoValues.some(value => value !== undefined) && ssoValues.some(value => value === undefined)) throw new Error('all SSO options are required when SSO is enabled')
  const ssoSessionMinutes = Number(options.ssoSessionMinutes)
  if (!Number.isSafeInteger(ssoSessionMinutes) || ssoSessionMinutes < 1 || ssoSessionMinutes > 24 * 60) throw new Error('--sso-session-minutes must be an integer between 1 and 1440')
  const sso = options.ssoPublicKey === undefined ? undefined : await createSsoVerifier(options.ssoPublicKey, options.ssoIssuer!, options.ssoAudience!, options.ssoOrigin!, ssoSessionMinutes)
  const launcherAdapter = fileURLToPath(new URL(
    existsSync(fileURLToPath(new URL('./runtime-launcher.js', import.meta.url)))
      ? './runtime-launcher.js'
      : './runtime-launcher.ts',
    import.meta.url,
  ))
  const launcherEntry = options.launcherEntry === undefined ? undefined : resolve(options.launcherEntry)
  const launcherCwd = options.launcherCwd === undefined ? undefined : resolve(options.launcherCwd)
  const needsTypeScriptLoader = launcherAdapter.endsWith('.ts') || launcherEntry?.endsWith('.ts') === true
  const processArgs = launcherEntry === undefined
    ? dshArgs
    : needsTypeScriptLoader ? ['--import', 'tsx/esm', launcherAdapter] : [launcherAdapter]
  const dshCliArgs = launcherEntry === undefined
    ? dshArgs
    : needsTypeScriptLoader ? ['--import', 'tsx/esm', launcherEntry] : [launcherEntry]
  const auth = new AuthStore(options.db, { ssoSessionTtlMs: ssoSessionMinutes * 60 * 1000 })
  const globalConfig = new GlobalConfigStore(resolve(options.gatewayEnv ?? `${dirname(resolve(options.db))}/gateway.env`))
  const publicSkills = new PublicSkillStore(resolve(options.dataRoot, 'public-agents'))
  const publicMcp = new PublicMcpStore(resolve(options.dataRoot, 'public-mcp.cordis.yml'))
  await publicMcp.initialize()
  const templateHome = join(resolve(options.dataRoot), 'profile-template')
  const legacyPresetSource = launcherCwd === undefined ? undefined : join(launcherCwd, 'packages/preset/agent-presets/presets/ptc')
  await prepareProfileTemplate(resolve(options.profileSource), templateHome, legacyPresetSource)
  const profileManager = new PublicProfileManager({ command: options.dshCommand, args: dshCliArgs, home: templateHome, ...(launcherCwd === undefined ? {} : { cwd: launcherCwd }) }, options.profile)
  const publicMcpRuntimePath = '.dsh-multiuser/public-mcp.cordis.yml'
  const processProvider = new LocalRuntimeProcessProvider(options.dshCommand, processArgs, options.profile, [publicMcpRuntimePath])
  const runtimes = new RuntimeManager({
    dataRoot: resolve(options.dataRoot),
    maxActiveRuntimes: Number(options.maxActiveRuntimes),
    idleMs: Number(options.idleMinutes) * 60 * 1000,
    launcherCwd,
    processProvider,
    recordSink: record => auth.upsertRuntimeRecord(record),
    prepareHome: async spec => {
      await prepareUserProfile(join(templateHome, 'profiles', options.profile), spec.home, legacyPresetSource)
      await publicMcp.installForRuntime(join(spec.home, publicMcpRuntimePath))
    },
    runtimeEnvironment: () => globalConfig.runtimeEnvironment(),
    publicAgentsHome: resolve(options.dataRoot, 'public-agents'),
    ...(launcherEntry === undefined ? {} : { environment: { DSH_LAUNCHER_ENTRY: launcherEntry, SSH_CONNECTION: 'dsh-multiuser-embedded-browser' } }),
    portAllocator: freePort,
    healthCheck: async (spec, isAlive) => {
      for (let attempt = 0; attempt < RUNTIME_HEALTH_CHECK_ATTEMPTS; attempt += 1) {
        // A runtime that already exited can never answer; fail fast instead of
        // holding the caller (and the first proxied request) for the full budget.
        if (isAlive?.() === false) return false
        try {
          const response = await fetch(`http://127.0.0.1:${String(spec.port)}/`)
          // The current Runtime protects `/` before its browser token exchange;
          // a 401 proves the loopback server is ready to authenticate.
          if (response.ok || response.status === 401) return true
        } catch { /* startup still in progress */ }
        if (attempt + 1 < RUNTIME_HEALTH_CHECK_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, RUNTIME_HEALTH_CHECK_INTERVAL_MS))
        }
      }
      return false
    },
  })
  const gatewayPort = Number(options.port) === 0 ? await freePort() : Number(options.port)
  const compatibility = await readCompatibility()
  const versionInfo = {
    name: 'dsh-multiuser',
    version: await readPackageVersion(),
    commit: process.env.DSH_MULTIUSER_COMMIT ?? null,
    dsh: { tested: compatibility.testedDshVersions, canary: compatibility.canaryDshVersions },
  }
  const gateway = new Gateway({
    auth, runtimes, host: options.host, port: gatewayPort,
    allowedHosts: options.allowedHost ?? [`${options.host}:${String(gatewayPort)}`],
    recoverStaleRuntimeRecords: records => processProvider.recoverStale(records),
    secureCookies: !options.insecureCookies,
    globalConfig,
    publicSkills,
    publicMcp,
    profileManager,
    ...(sso === undefined ? {} : { sso }),
    readiness: createReadinessProbe({
      db: options.db,
      dataRoot: options.dataRoot,
      profile: options.profile,
      testedDshVersions: compatibility.testedDshVersions,
      runDshVersion: () => runDshVersionCommand(options.dshCommand, dshCliArgs, launcherCwd),
    }),
    versionInfo,
  })
  await gateway.start()
  const reapTimer = setInterval(() => { void runtimes.reapIdle() }, 60_000)
  const stop = async (): Promise<void> => {
    gateway.beginShutdown()
    clearInterval(reapTimer)
    await gateway.close()
    await runtimes.close()
    auth.close()
  }
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)) })
  process.once('SIGINT', () => { void stop().then(() => process.exit(130)) })
  process.stdout.write(`dsh-multiuser gateway: http://${options.host}:${String(gateway.port)}\n`)
  await new Promise<void>(() => {})
  await stop()
} catch (error) {
  process.stderr.write(`dsh-multiuser gateway: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

async function createSsoVerifier(entries: readonly string[], issuer: string, audience: string, origin: string, _sessionMinutes: number): Promise<SsoVerifier> {
  const keys = new Map<string, CryptoKey>()
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    if (separator < 1 || separator === entry.length - 1) throw new Error('--sso-public-key must use kid=/absolute/key.pem')
    const kid = entry.slice(0, separator)
    const path = entry.slice(separator + 1)
    if (keys.has(kid) || !path.startsWith('/')) throw new Error('SSO key ids must be unique and key paths must be absolute')
    keys.set(kid, await importSPKI(await readFile(path, 'utf8'), 'EdDSA'))
  }
  return new SsoVerifier({ issuer, audience, keys, allowedOrigin: origin })
}
