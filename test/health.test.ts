import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { AuthStore } from '../src/auth-local.js'
import { createReadinessProbe, Gateway, type GatewayOptions, type ReadinessReport } from '../src/gateway.js'
import { GlobalConfigStore } from '../src/global-config.js'
import { PublicSkillStore } from '../src/public-content.js'
import { PublicMcpStore } from '../src/public-mcp.js'
import type { ManagedProcess, RuntimeLaunchSpec, RuntimeProcessProvider } from '../src/runtime-manager.js'
import { RuntimeManager } from '../src/runtime-manager.js'

const gateways: Gateway[] = []
const resources: Array<{ close(): Promise<void> | void }> = []

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close()
  for (const resource of resources.splice(0).reverse()) await resource.close()
})

class FakeRuntimeProcess implements ManagedProcess {
  pid = 700
  constructor(private readonly server: Server, private readonly webSockets: WebSocketServer) {}
  async kill(): Promise<void> {
    this.webSockets.close()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}

class FakeRuntimeProvider implements RuntimeProcessProvider {
  async spawn(spec: RuntimeLaunchSpec): Promise<ManagedProcess> {
    const server = createServer((req, res) => {
      if (req.url?.includes('?token=fake-launch-token')) {
        res.writeHead(303, { location: '/', 'set-cookie': ['dsh-auth-fake=v1.test'] })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>runtime</html>')
    })
    const webSockets = new WebSocketServer({ noServer: true })
    await new Promise<void>(resolve => server.listen(spec.port, '127.0.0.1', () => resolve()))
    return Object.assign(new FakeRuntimeProcess(server, webSockets), { launchUrl: Promise.resolve(`http://127.0.0.1:${String(spec.port)}/?token=fake-launch-token`) })
  }
}

class CountingRuntimeProvider implements RuntimeProcessProvider {
  spawnCalls = 0
  constructor(private readonly delegate: RuntimeProcessProvider = new FakeRuntimeProvider()) {}
  async spawn(spec: RuntimeLaunchSpec): Promise<ManagedProcess> {
    this.spawnCalls += 1
    return this.delegate.spawn(spec)
  }
}

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

async function makeGateway(overrides: {
  readiness?: () => Promise<ReadinessReport>
  versionInfo?: GatewayOptions['versionInfo']
  provider?: RuntimeProcessProvider
} = {}): Promise<{ gateway: Gateway; base: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-multiuser-health-'))
  resources.push({ close: () => rm(dir, { recursive: true, force: true }) })
  const auth = new AuthStore(join(dir, 'gateway.sqlite'))
  resources.push(auth)
  const provider = overrides.provider ?? new FakeRuntimeProvider()
  const runtimes = new RuntimeManager({
    dataRoot: join(dir, 'users'),
    maxActiveRuntimes: 2,
    idleMs: 1_800_000,
    processProvider: provider,
    portAllocator: freePort,
    recordSink: record => auth.upsertRuntimeRecord(record),
    healthCheck: async spec => {
      const response = await fetch(`http://127.0.0.1:${String(spec.port)}/`)
      return response.ok
    },
  })
  resources.push(runtimes)
  const publicMcp = new PublicMcpStore(join(dir, 'public-mcp.cordis.yml'))
  await publicMcp.initialize()
  const gatewayPort = await freePort()
  const gateway = new Gateway({
    auth, runtimes, port: gatewayPort, secureCookies: false,
    allowedHosts: [`127.0.0.1:${String(gatewayPort)}`],
    globalConfig: new GlobalConfigStore(join(dir, 'gateway.env')),
    publicSkills: new PublicSkillStore(join(dir, 'public-agents')),
    publicMcp,
    ...(overrides.readiness === undefined ? {} : { readiness: overrides.readiness }),
    ...(overrides.versionInfo === undefined ? {} : { versionInfo: overrides.versionInfo }),
  })
  await gateway.start()
  gateways.push(gateway)
  return { gateway, base: `http://127.0.0.1:${String(gatewayPort)}`, dir }
}

async function writeProfileTemplate(dataRoot: string, profile: string): Promise<void> {
  await mkdir(join(dataRoot, 'profile-template', 'profiles', profile), { recursive: true })
  await writeFile(join(dataRoot, 'profile-template', 'profiles', profile, 'package.json'), `${JSON.stringify({ name: 'user-runtime-template' })}\n`)
}

function rawStatusFor(base: string, path: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(path, base)
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: Number(url.port), path: url.pathname, headers }, response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    request.once('error', reject)
    request.end()
  })
}

describe('health endpoints', () => {
  it('serves the three endpoints without a cookie and without starting a user runtime', async () => {
    const provider = new CountingRuntimeProvider()
    const { base } = await makeGateway({ provider })
    const expected: Record<string, number> = { '/healthz': 200, '/readyz': 503, '/version': 200 }
    for (const [path, status] of Object.entries(expected)) {
      const response = await fetch(`${base}${path}`)
      expect(response.status).toBe(status)
    }
    expect(provider.spawnCalls).toBe(0)
  })

  it('returns a stable redacted 503 when the readiness probe rejects', async () => {
    const probeError = new Error('database password=super-secret')
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { base } = await makeGateway({ readiness: async () => { throw probeError } })
      const response = await fetch(`${base}/readyz`, { headers: { 'x-request-id': 'readyz-test' } })
      expect(response.status).toBe(503)
      const body = await response.json()
      expect(body).toEqual({
        status: 'not-ready',
        checks: [{ code: 'READINESS_PROBE_FAILED', ok: false, detail: 'readiness probe failed' }],
      })
      expect(JSON.stringify(body)).not.toContain('super-secret')
      expect(errorLog).toHaveBeenCalledWith('readiness probe failed', { requestId: 'readyz-test', error: probeError })
    } finally {
      errorLog.mockRestore()
    }
  })

  it('returns the same stable redacted 503 when the readiness probe resolves with a malformed report', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      for (const malformed of [
        { ok: true, checks: undefined },
        { ok: true, checks: 'not-an-array' },
        { ok: true, checks: [null] },
      ]) {
        const { base } = await makeGateway({ readiness: async () => malformed as never })
        const response = await fetch(`${base}/readyz`, { headers: { 'x-request-id': 'readyz-malformed' } })
        // Shaping the report must fail closed here too: an exception escaping the
        // readiness guard reaches the top-level handler, which echoes the raw
        // `error.message` to an unauthenticated caller.
        expect(response.status).toBe(503)
        const body = await response.json()
        expect(body).toEqual({
          status: 'not-ready',
          checks: [{ code: 'READINESS_PROBE_FAILED', ok: false, detail: 'readiness probe failed' }],
        })
        expect(JSON.stringify(body)).not.toMatch(/Cannot read|is not a function|undefined/)
      }
    } finally {
      errorLog.mockRestore()
    }
  })

  it('rejects an untrusted Host for the three endpoints with 421', async () => {
    const { base } = await makeGateway()
    for (const path of ['/healthz', '/readyz', '/version']) {
      expect(await rawStatusFor(base, path, { host: 'evil.example' })).toBe(421)
    }
  })

  it('reports draining on /healthz after beginShutdown', async () => {
    const { gateway, base } = await makeGateway()
    const before = await fetch(`${base}/healthz`)
    expect(before.status).toBe(200)
    expect(await before.json()).toEqual({ status: 'ok' })
    gateway.beginShutdown()
    const after = await fetch(`${base}/healthz`)
    expect(after.status).toBe(503)
    expect(await after.json()).toEqual({ status: 'draining' })
  })

  it('reports /readyz 503 with a stable code when the database is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-multiuser-health-'))
    resources.push({ close: () => rm(dir, { recursive: true, force: true }) })
    const auth = new AuthStore(join(dir, 'gateway.sqlite'))
    resources.push(auth)
    await writeProfileTemplate(dir, 'user-runtime')
    const { base } = await makeGateway({
      readiness: createReadinessProbe({
        db: join(dir, 'absent.sqlite'),
        dataRoot: dir,
        profile: 'user-runtime',
        testedDshVersions: ['1.2.3'],
        runDshVersion: async () => '1.2.3',
      }),
    })
    const response = await fetch(`${base}/readyz`)
    expect(response.status).toBe(503)
    const body = await response.json() as ReadinessReport & { status: string }
    expect(body.status).toBe('not-ready')
    expect(body.checks.some(check => check.code === 'DB' && !check.ok)).toBe(true)
    expect(JSON.stringify(body)).not.toContain(dir)
  })

  it('reports /readyz 503 with PROFILE_TEMPLATE_MISSING when the template is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-multiuser-health-'))
    resources.push({ close: () => rm(dir, { recursive: true, force: true }) })
    const auth = new AuthStore(join(dir, 'gateway.sqlite'))
    resources.push(auth)
    const { base } = await makeGateway({
      readiness: createReadinessProbe({
        db: join(dir, 'gateway.sqlite'),
        dataRoot: dir,
        profile: 'user-runtime',
        testedDshVersions: ['1.2.3'],
        runDshVersion: async () => '1.2.3',
      }),
    })
    const response = await fetch(`${base}/readyz`)
    expect(response.status).toBe(503)
    const body = await response.json() as ReadinessReport & { status: string }
    expect(body.status).toBe('not-ready')
    expect(body.checks.some(check => check.code === 'PROFILE_TEMPLATE_MISSING' && !check.ok)).toBe(true)
    expect(JSON.stringify(body)).not.toContain(dir)
  })

  it('reports /readyz 503 with DSH_VERSION_UNSUPPORTED when the version is not tested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-multiuser-health-'))
    resources.push({ close: () => rm(dir, { recursive: true, force: true }) })
    const auth = new AuthStore(join(dir, 'gateway.sqlite'))
    resources.push(auth)
    await writeProfileTemplate(dir, 'user-runtime')
    const { base } = await makeGateway({
      readiness: createReadinessProbe({
        db: join(dir, 'gateway.sqlite'),
        dataRoot: dir,
        profile: 'user-runtime',
        testedDshVersions: ['9.9.9'],
        runDshVersion: async () => '1.2.3',
      }),
    })
    const response = await fetch(`${base}/readyz`)
    expect(response.status).toBe(503)
    const body = await response.json() as ReadinessReport & { status: string }
    expect(body.status).toBe('not-ready')
    expect(body.checks.some(check => check.code === 'DSH_VERSION_UNSUPPORTED' && !check.ok)).toBe(true)
  })

  it('reports /readyz 200 with all checks ok when everything is healthy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-multiuser-health-'))
    resources.push({ close: () => rm(dir, { recursive: true, force: true }) })
    const auth = new AuthStore(join(dir, 'gateway.sqlite'))
    resources.push(auth)
    await writeProfileTemplate(dir, 'user-runtime')
    const { base } = await makeGateway({
      readiness: createReadinessProbe({
        db: join(dir, 'gateway.sqlite'),
        dataRoot: dir,
        profile: 'user-runtime',
        testedDshVersions: ['1.2.3'],
        runDshVersion: async () => '1.2.3',
      }),
    })
    const response = await fetch(`${base}/readyz`)
    expect(response.status).toBe(200)
    const body = await response.json() as ReadinessReport & { status: string }
    expect(body.status).toBe('ready')
    expect(body.checks).toHaveLength(3)
    expect(body.checks.every(check => check.ok)).toBe(true)
    expect(body.checks.map(check => check.code).sort()).toEqual(['DB', 'DSH_VERSION', 'PROFILE_TEMPLATE'])
    expect(JSON.stringify(body)).not.toContain(dir)
  })

  it('caches the readiness probe for 60s so the DSH version command runs once', async () => {
    let calls = 0
    const probeDir = await mkdtemp(join(tmpdir(), 'dsh-multiuser-health-cache-'))
    const probeAuth = new AuthStore(join(probeDir, 'gateway.sqlite'))
    resources.push(probeAuth)
    await writeProfileTemplate(probeDir, 'user-runtime')
    const probe = createReadinessProbe({
      db: join(probeDir, 'gateway.sqlite'),
      dataRoot: probeDir,
      profile: 'user-runtime',
      testedDshVersions: ['1.2.3'],
      runDshVersion: async () => { calls += 1; return '1.2.3' },
      clock: () => 0,
      cacheMs: 60_000,
    })
    const { base } = await makeGateway({ readiness: probe })
    const first = await fetch(`${base}/readyz`)
    expect(first.status).toBe(200)
    const second = await fetch(`${base}/readyz`)
    expect(second.status).toBe(200)
    expect(calls).toBe(1)
  })

  it('returns build identity from /version without leaking secrets', async () => {
    const versionInfo: GatewayOptions['versionInfo'] = {
      name: 'dsh-multiuser',
      version: '1.2.3',
      commit: 'abc123',
      dsh: { tested: ['1.2.3'], canary: ['1.3.0-alpha'] },
    }
    const { base } = await makeGateway({ versionInfo })
    const response = await fetch(`${base}/version`)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ name: 'dsh-multiuser', version: '1.2.3', commit: 'abc123', dsh: { tested: ['1.2.3'], canary: ['1.3.0-alpha'] }, node: process.version })
    const serialized = JSON.stringify(body).toLowerCase()
    for (const word of ['apikey', 'token', 'secret', 'password']) expect(serialized).not.toContain(word)
  })
})
