import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

export type RuntimeStatus = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'FAILED'
export type RuntimeActivity = 'agent' | 'terminal' | 'background' | 'file' | 'browser'

export interface RuntimeLaunchSpec {
  userId: string
  home: string
  workspace: string
  logs: string
  port: number
  launchCwd?: string | undefined
  env: Record<string, string>
}

export interface ManagedProcess {
  pid: number
  kill(signal?: NodeJS.Signals): Promise<void>
  onExit?(listener: (code: number | null) => void): void
  launchUrl?: Promise<string>
}

export interface RuntimeProcessProvider {
  spawn(spec: RuntimeLaunchSpec): Promise<ManagedProcess>
}

const RUNTIME_SECRET_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i
const RUNTIME_ALLOWED_SECRET_NAMES = new Set(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_PUBLIC_LLM_PROVIDERS'])

/**
 * Keep the Runtime launcher environment usable while excluding unrelated host
 * secrets. Deployment-specific values still enter through `spec.env`.
 */
export function runtimeParentEnv(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) =>
    value !== undefined && (!RUNTIME_SECRET_PATTERN.test(key) || RUNTIME_ALLOWED_SECRET_NAMES.has(key) || /^DSH_PUBLIC_LLM_KEY_[A-Z0-9_]+$/u.test(key)))) as Record<string, string>
}

/** Local child-process Provider used by the single-host deployment. */
export class LocalRuntimeProcessProvider implements RuntimeProcessProvider {
  constructor(private readonly command: string, private readonly args: readonly string[] = [], private readonly profile?: string, private readonly patchPaths: readonly string[] = []) {}

  /** Spawn one DSH process with a user-specific home, workspace, and log file. */
  async spawn(spec: RuntimeLaunchSpec): Promise<ManagedProcess> {
    await mkdir(spec.logs, { recursive: true })
    await mkdir(spec.home, { recursive: true })
    await mkdir(join(spec.home, 'tmp'), { recursive: true })
    await mkdir(spec.workspace, { recursive: true })
    const log = createWriteStream(join(spec.logs, 'runtime.log'), { flags: 'a' })
    let launchUrlResolve!: (url: string) => void
    let launchUrlReject!: (error: Error) => void
    const launchUrl = new Promise<string>((resolve, reject) => { launchUrlResolve = resolve; launchUrlReject = reject })
    void launchUrl.catch(() => {})
    const launchPattern = /dsh web: (https?:\/\/[^\s()]+\?token=[A-Za-z0-9_-]{43})(?:\s|$)/u
    let output = ''
    let launchResolved = false
    const consume = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf8')}`.slice(-8_000)
      const match = launchPattern.exec(output)
      if (match !== null && !launchResolved) {
        launchResolved = true
        launchUrlResolve(match[1]!)
      }
      log.write(chunk.toString('utf8').replace(/([?&]token=)[A-Za-z0-9_-]+/gu, '$1<redacted>'))
    }
    const launcherArgs = runtimeLauncherArgs(this.profile, spec.port, this.patchPaths.map(path => resolve(spec.home, path)))
    const child = spawn(this.command, [...this.args, ...launcherArgs], {
      cwd: spec.launchCwd ?? spec.workspace,
      env: { ...runtimeParentEnv(), ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.once('error', error => { if (!launchResolved) launchUrlReject(error) })
    child.once('exit', code => { if (!launchResolved) launchUrlReject(new Error(`runtime exited before publishing its launch URL (code ${String(code)})`)) })
    return {
      pid: child.pid ?? -1,
      launchUrl,
      kill: async (signal = 'SIGTERM') => {
        if (child.exitCode !== null || child.signalCode !== null) return
        const exited = new Promise<void>(resolve => { child.once('close', () => resolve()) })
        if (process.platform !== 'win32' && child.pid !== undefined) {
          try { process.kill(-child.pid, signal) } catch { child.kill(signal) }
        } else child.kill(signal)
        await exited
      },
      onExit: listener => { child.once('exit', code => listener(code)) },
    }
  }

  /**
   * Terminate an orphan only when its environment carries the recorded launch
   * marker. A stale PID without that marker is never treated as this Runtime.
   */
  recoverStale(records: readonly RuntimeRecord[]): void {
    if (process.platform === 'win32') return
    for (const record of records) {
      if (record.pid === undefined || record.pid <= 0 || record.launchId === undefined) continue
      try {
        const environment = readFileSync(`/proc/${String(record.pid)}/environ`, 'utf8')
        if (!environment.split('\0').includes(`DSH_MULTIUSER_LAUNCH_ID=${record.launchId}`)) continue
        process.kill(-record.pid, 'SIGTERM')
      } catch {
        // The process may already be gone; an unreadable or mismatched PID is not ours to kill.
      }
    }
  }
}

/** Build DSH launcher arguments with deployment patches kept separate from user Profile files. */
export function runtimeLauncherArgs(profile: string | undefined, port: number, patchPaths: readonly string[]): string[] {
  const patches = patchPaths.flatMap(path => ['--patch', resolve(path)])
  return profile === undefined
    ? ['web', ...patches, '--no-open', '--port', String(port)]
    : ['--profile', profile, ...patches, '--no-open', '--port', String(port)]
}

export interface RuntimeRecord {
  userId: string
  status: RuntimeStatus
  pid?: number | undefined
  port?: number | undefined
  launchId?: string | undefined
  startedAt?: number | undefined
  lastActiveAt: number
  recentError?: string | undefined
}

export interface RuntimeManagerOptions {
  dataRoot: string
  maxActiveRuntimes: number
  idleMs: number
  now?: () => number
  processProvider: RuntimeProcessProvider
  /**
   * Resolve once the spawned runtime serves its loopback port.
   *
   * `isAlive` reports whether the process this start owns is still the tracked
   * one, so a runtime that crashed on boot fails fast instead of burning the
   * whole probe budget.
   */
  healthCheck: (spec: RuntimeLaunchSpec, isAlive?: () => boolean) => Promise<boolean>
  portAllocator: () => Promise<number>
  environment?: Record<string, string>
  runtimeEnvironment?: () => Promise<Record<string, string>>
  publicAgentsHome?: string
  launcherCwd?: string | undefined
  recordSink?: (record: RuntimeRecord) => void
  prepareHome?: (spec: RuntimeLaunchSpec) => Promise<void>
}

interface RuntimeEntry {
  record: RuntimeRecord
  process?: ManagedProcess | undefined
  start?: Promise<RuntimeRecord> | undefined
  activities: Map<RuntimeActivity, number>
}

function active(status: RuntimeStatus): boolean {
  return status === 'STARTING' || status === 'RUNNING' || status === 'STOPPING'
}

function runtimePersistentEnvironment(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    npm_config_cache: join(home, 'npm-cache'),
    pnpm_config_store_dir: join(home, 'pnpm-store'),
    TMPDIR: join(home, 'tmp'),
  }
}

/** Owns one loopback DSH process per principal and serializes its lifecycle. */
export class RuntimeManager {
  private readonly entries = new Map<string, RuntimeEntry>()
  private readonly now: () => number
  private readonly options: RuntimeManagerOptions

  constructor(options: RuntimeManagerOptions) {
    if (!Number.isInteger(options.maxActiveRuntimes) || options.maxActiveRuntimes < 1) throw new Error('maxActiveRuntimes must be a positive integer')
    if (!Number.isFinite(options.idleMs) || options.idleMs <= 0) throw new Error('idleMs must be positive')
    this.options = { ...options, dataRoot: resolve(options.dataRoot) }
    this.now = options.now ?? Date.now
  }

  /** Ensure one healthy runtime exists for a principal. Concurrent calls share one start. */
  async ensureRunning(userId: string): Promise<RuntimeRecord> {
    const entry = this.entry(userId)
    if (entry.record.status === 'RUNNING') {
      entry.record.lastActiveAt = this.now()
      this.persist(entry)
      return { ...entry.record }
    }
    if (entry.start !== undefined) return entry.start
    const activeCount = [...this.entries.values()].filter(value => active(value.record.status)).length
    if (activeCount >= this.options.maxActiveRuntimes) throw new Error(`maxActiveRuntimes (${String(this.options.maxActiveRuntimes)}) reached`)
    entry.start = this.start(entry).finally(() => { entry.start = undefined })
    return entry.start
  }

  /** Return a control record without exposing process handles. */
  get(userId: string): RuntimeRecord | undefined {
    const record = this.entries.get(userId)?.record
    return record === undefined ? undefined : { ...record }
  }

  /** Mark work or a browser connection as active; zero removes that activity kind. */
  setActivity(userId: string, kind: RuntimeActivity, count: number): void {
    if (!Number.isInteger(count) || count < 0) throw new Error('activity count must be a non-negative integer')
    const entry = this.entry(userId)
    if (count === 0) entry.activities.delete(kind)
    else entry.activities.set(kind, count)
    entry.record.lastActiveAt = this.now()
    this.persist(entry)
  }

  /** Return the current count for one activity kind without exposing mutable state. */
  activityCount(userId: string, kind: RuntimeActivity): number {
    return this.entries.get(userId)?.activities.get(kind) ?? 0
  }

  /** Stop one runtime and leave its durable record in STOPPED state. */
  async stop(userId: string): Promise<void> {
    const entry = this.entries.get(userId)
    if (entry === undefined || entry.process === undefined || !active(entry.record.status)) return
    entry.record.status = 'STOPPING'
    this.persist(entry)
    await entry.process.kill('SIGTERM')
    entry.process = undefined
    entry.record.status = 'STOPPED'
    entry.record.pid = undefined
    entry.record.port = undefined
    this.persist(entry)
  }

  /** Stop runtimes that have no activity and exceeded the idle interval. */
  async reapIdle(): Promise<void> {
    const cutoff = this.now() - this.options.idleMs
    const candidates = [...this.entries.values()].filter(entry => entry.record.status === 'RUNNING' && entry.record.lastActiveAt <= cutoff && [...entry.activities.values()].every(count => count === 0))
    for (const entry of candidates) await this.stop(entry.record.userId)
  }

  /** Gracefully stop all currently managed processes. */
  async stopAll(): Promise<void> {
    for (const entry of this.entries.values()) await this.stop(entry.record.userId)
  }

  /** Return the launch URL emitted by a running Runtime process. */
  async launchUrl(userId: string): Promise<string> {
    const process = this.entries.get(userId)?.process
    if (process?.launchUrl === undefined) throw new Error('runtime did not expose an authenticated launch URL')
    return process.launchUrl
  }

  /** Gracefully stop all managed processes before shutting down the manager. */
  async close(): Promise<void> { await this.stopAll() }

  private entry(userId: string): RuntimeEntry {
    let entry = this.entries.get(userId)
    if (entry === undefined) {
      entry = { record: { userId, status: 'STOPPED', lastActiveAt: this.now() }, activities: new Map() }
      this.entries.set(userId, entry)
    }
    return entry
  }

  private async start(entry: RuntimeEntry): Promise<RuntimeRecord> {
    const { userId } = entry.record
    entry.record.status = 'STARTING'
    entry.record.recentError = undefined
    this.persist(entry)
    const userRoot = join(this.options.dataRoot, userId)
    const home = join(userRoot, 'dsh-home')
    const port = await this.options.portAllocator()
    const launchId = randomUUID()
    const spec: RuntimeLaunchSpec = {
      userId,
      home,
      workspace: join(userRoot, 'workspace'),
      logs: join(userRoot, 'logs'),
      port,
      ...(this.options.launcherCwd === undefined ? {} : { launchCwd: this.options.launcherCwd }),
      env: { ...this.options.environment, ...await this.options.runtimeEnvironment?.(), ...runtimePersistentEnvironment(home), ...(this.options.publicAgentsHome === undefined ? {} : { DSH_AGENTS_HOME: this.options.publicAgentsHome }), DSH_HOME: home, DSH_RUNTIME_WORKSPACE: join(userRoot, 'workspace'), DSH_MULTIUSER_LAUNCH_ID: launchId },
    }
    try {
      await this.options.prepareHome?.(spec)
      const process = await this.options.processProvider.spawn(spec)
      entry.process = process
      entry.record = { ...entry.record, status: 'STARTING', pid: process.pid, port, launchId }
      this.persist(entry)
      process.onExit?.(code => {
        if (entry.process !== process) return
        entry.process = undefined
        entry.record.status = code === 0 ? 'STOPPED' : 'FAILED'
        entry.record.pid = undefined
        entry.record.port = undefined
        if (code !== 0) entry.record.recentError = `runtime exited with code ${String(code)}`
        this.persist(entry)
      })
      if (entry.process !== process) throw new Error('runtime exited during health check')
      if (!await this.options.healthCheck(spec, () => entry.process === process)) throw new Error('health check failed')
      if (entry.process !== process) throw new Error('runtime exited during health check')
      entry.record = { ...entry.record, status: 'RUNNING', startedAt: this.now(), lastActiveAt: this.now() }
      this.persist(entry)
      return { ...entry.record }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      entry.record.status = 'FAILED'
      entry.record.recentError = reason
      this.persist(entry)
      if (entry.process !== undefined) {
        await entry.process.kill('SIGTERM')
        entry.process = undefined
      }
      this.persist(entry)
      throw new Error(reason)
    }
  }

  private persist(entry: RuntimeEntry): void { this.options.recordSink?.({ ...entry.record }) }
}
