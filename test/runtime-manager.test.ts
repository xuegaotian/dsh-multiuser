import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeManager, runtimeLauncherArgs, type ManagedProcess, type RuntimeLaunchSpec, type RuntimeProcessProvider } from '../src/runtime-manager.js'

class FakeProcess implements ManagedProcess {
  readonly pid: number
  killed = false
  constructor(pid: number, private readonly exitListener: (code: number | null) => void) { this.pid = pid }
  async kill(): Promise<void> { this.killed = true; this.exitListener(0) }
  exit(code: number | null): void { this.exitListener(code) }
}

class FakeProvider implements RuntimeProcessProvider {
  nextPid = 100
  specs: RuntimeLaunchSpec[] = []
  processes: FakeProcess[] = []
  async spawn(spec: RuntimeLaunchSpec): Promise<ManagedProcess> {
    this.specs.push(spec)
    const process = new FakeProcess(this.nextPid++, () => {})
    this.processes.push(process)
    return process
  }
}

const managers: RuntimeManager[] = []
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close() })

function manager(provider: FakeProvider, now: () => number, options: Partial<ConstructorParameters<typeof RuntimeManager>[0]> = {}): RuntimeManager {
  const value = new RuntimeManager({
    dataRoot: '/srv/dsh-multiuser/users',
    maxActiveRuntimes: 2,
    idleMs: 30 * 60 * 1000,
    now,
    processProvider: provider,
    healthCheck: async () => true,
    portAllocator: async () => 5000 + provider.specs.length,
    launcherCwd: '/opt/dsh',
    ...options,
  })
  managers.push(value)
  return value
}

describe('RuntimeManager', () => {
  it('loads a deployment MCP patch without changing the user Profile patch', () => {
    expect(runtimeLauncherArgs('user-runtime', 18081, ['/srv/dsh/public-mcp.cordis.yml'])).toEqual([
      '--profile', 'user-runtime', '--patch', '/srv/dsh/public-mcp.cordis.yml', '--no-open', '--port', '18081',
    ])
  })

  it('serializes concurrent starts for one user and reuses the healthy runtime', async () => {
    const provider = new FakeProvider()
    const value = manager(provider, () => 1_700_000_000_000)
    const [first, second] = await Promise.all([value.ensureRunning('user-a'), value.ensureRunning('user-a')])
    expect(first).toEqual(second)
    expect(provider.specs).toHaveLength(1)
    expect(provider.specs[0]).toMatchObject({ userId: 'user-a', port: 5000, launchCwd: '/opt/dsh', home: '/srv/dsh-multiuser/users/user-a/dsh-home', workspace: '/srv/dsh-multiuser/users/user-a/workspace' })
    expect(provider.specs[0]?.env.DSH_MULTIUSER_LAUNCH_ID).toMatch(/^[0-9a-f-]{36}$/u)
    expect(value.get('user-a')).toMatchObject({ status: 'RUNNING', pid: 100, port: 5000 })
    expect(value.get('user-a')?.launchId).toBe(provider.specs[0]?.env.DSH_MULTIUSER_LAUNCH_ID)
  })

  it('rejects a new start at the active-runtime limit without stopping existing users', async () => {
    const provider = new FakeProvider()
    const value = manager(provider, () => 1_700_000_000_000, { maxActiveRuntimes: 1 })
    await value.ensureRunning('user-a')
    await expect(value.ensureRunning('user-b')).rejects.toThrow(/maxActiveRuntimes/)
    expect(value.get('user-a')).toMatchObject({ status: 'RUNNING', pid: 100 })
    expect(provider.processes[0]?.killed).toBe(false)
  })

  it('marks failed health checks and kills the failed process', async () => {
    const provider = new FakeProvider()
    const value = manager(provider, () => 1_700_000_000_000, { healthCheck: async () => false })
    await expect(value.ensureRunning('user-a')).rejects.toThrow(/health check failed/)
    expect(value.get('user-a')).toMatchObject({ status: 'FAILED', recentError: 'health check failed' })
    expect(provider.processes[0]?.killed).toBe(true)
  })

  it('settles stop when the child exits immediately after the signal', async () => {
    const provider = new FakeProvider()
    const value = manager(provider, () => 1_700_000_000_000)
    await value.ensureRunning('user-a')
    await value.stop('user-a')
    expect(value.get('user-a')).toMatchObject({ status: 'STOPPED', pid: undefined, port: undefined })
  })

  it('stops every active runtime when shared configuration changes', async () => {
    const provider = new FakeProvider()
    const value = manager(provider, () => 1_700_000_000_000)
    await Promise.all([value.ensureRunning('user-a'), value.ensureRunning('user-b')])
    await value.stopAll()
    expect(value.get('user-a')).toMatchObject({ status: 'STOPPED', pid: undefined, port: undefined })
    expect(value.get('user-b')).toMatchObject({ status: 'STOPPED', pid: undefined, port: undefined })
    expect(provider.processes.every(process => process.killed)).toBe(true)
  })

  it('stops only after the runtime is fully idle for the configured interval', async () => {
    let now = 1_700_000_000_000
    const provider = new FakeProvider()
    const value = manager(provider, () => now)
    await value.ensureRunning('user-a')
    value.setActivity('user-a', 'browser', 1)
    now += 31 * 60 * 1000
    await value.reapIdle()
    expect(value.get('user-a')?.status).toBe('RUNNING')
    value.setActivity('user-a', 'browser', 0)
    now += 31 * 60 * 1000
    await value.reapIdle()
    expect(value.get('user-a')?.status).toBe('STOPPED')
    expect(provider.processes[0]?.killed).toBe(true)
  })

  it('keeps a runtime alive for every tracked activity category', async () => {
    let now = 1_700_000_000_000
    const provider = new FakeProvider()
    const value = manager(provider, () => now)
    await value.ensureRunning('user-a')
    for (const kind of ['agent', 'terminal', 'background', 'file', 'browser'] as const) {
      value.setActivity('user-a', kind, 1)
      now += 31 * 60 * 1000
      await value.reapIdle()
      expect(value.get('user-a')?.status).toBe('RUNNING')
      value.setActivity('user-a', kind, 0)
    }
    now += 31 * 60 * 1000
    await value.reapIdle()
    expect(value.get('user-a')?.status).toBe('STOPPED')
  })

  it('does not use the username as a runtime data directory key', async () => {
    const provider = new FakeProvider()
    const value = manager(provider, () => 1_700_000_000_000)
    await value.ensureRunning('principal-uuid')
    expect(provider.specs[0]?.home).toBe('/srv/dsh-multiuser/users/principal-uuid/dsh-home')
    expect(provider.specs[0]?.home).not.toContain('alice')
  })

  it('isolates private state while exposing the shared public Skill root', async () => {
    const provider = new FakeProvider()
    const value = manager(provider, () => 1_700_000_000_000, {
      publicAgentsHome: '/srv/dsh-multiuser/users/public-agents',
    })

    await value.ensureRunning('user-a')

    expect(provider.specs[0]?.env).toMatchObject({
      DSH_HOME: '/srv/dsh-multiuser/users/user-a/dsh-home',
      DSH_AGENTS_HOME: '/srv/dsh-multiuser/users/public-agents',
      HOME: '/srv/dsh-multiuser/users/user-a/dsh-home',
      XDG_CACHE_HOME: '/srv/dsh-multiuser/users/user-a/dsh-home/.cache',
      XDG_CONFIG_HOME: '/srv/dsh-multiuser/users/user-a/dsh-home/.config',
      XDG_DATA_HOME: '/srv/dsh-multiuser/users/user-a/dsh-home/.local/share',
      npm_config_cache: '/srv/dsh-multiuser/users/user-a/dsh-home/npm-cache',
      pnpm_config_store_dir: '/srv/dsh-multiuser/users/user-a/dsh-home/pnpm-store',
      TMPDIR: '/srv/dsh-multiuser/users/user-a/dsh-home/tmp',
    })
  })
})
