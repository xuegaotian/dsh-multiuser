import { createServer, request as httpRequest, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPair, SignJWT } from 'jose'
import WebSocket, { WebSocketServer } from 'ws'
import { AuthStore } from '../src/auth-local.js'
import { adminSessionRpc, Gateway, isAllowedAdminRpc } from '../src/gateway.js'
import { GlobalConfigStore } from '../src/global-config.js'
import { PublicSkillStore } from '../src/public-content.js'
import { PublicMcpStore } from '../src/public-mcp.js'
import type { PublicProfile } from '../src/public-profile.js'
import { RuntimeManager, runtimeParentEnv, type ManagedProcess, type RuntimeLaunchSpec, type RuntimeProcessProvider } from '../src/runtime-manager.js'
import { SsoVerifier } from '../src/sso.js'

const gateways: Gateway[] = []
const resources: Array<{ close(): Promise<void> | void }> = []
let signingKey: CryptoKey | undefined
let verifierKey: CryptoKey | undefined

async function ssoVerifier(): Promise<SsoVerifier> {
  if (signingKey === undefined || verifierKey === undefined) {
    const pair = await generateKeyPair('EdDSA')
    signingKey = pair.privateKey
    verifierKey = pair.publicKey
  }
  return new SsoVerifier({ issuer: 'example-idp', audience: 'dsh-multiuser', allowedOrigin: 'http://127.0.0.1:8000', keys: new Map([['sso-2026-01', verifierKey]]) })
}
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
      if (req.url?.startsWith('/api/session/list')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: 'fake', result: { ok: true, value: { items: [] } } }))
        return
      }
      if (req.url?.startsWith('/api/session/page')) {
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(Buffer.from(chunk)))
        req.on('end', () => {
          const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            rpcId: string
            method: string
            payload: { args: { request: unknown } }
          }
          const valid = request.method === 'session/page'
            && JSON.stringify(request.payload.args.request) === JSON.stringify({
              address: { kind: 'session', sessionId: 'session-1' },
              throughSeq: 42,
              maxMessages: 20,
            })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            type: 'server-response',
            rpcId: request.rpcId,
            result: valid
              ? { ok: true, value: { records: [{ type: 'event', event: { type: 'user/message', seq: 42, time: 1, data: { text: 'hello' } } }], hasMore: false } }
              : { ok: false, error: { code: 'bad-request', message: 'invalid page request', details: {} } },
          }))
        })
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>runtime</html>')
    })
    const webSockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      webSockets.handleUpgrade(req, socket, head, client => {
        webSockets.emit('connection', client, req)
        client.on('message', (data, isBinary) => client.send(Buffer.from(`${String(isBinary)}:${data.toString()}`)))
      })
    })
    await new Promise<void>(resolve => server.listen(spec.port, '127.0.0.1', () => resolve()))
    return Object.assign(new FakeRuntimeProcess(server, webSockets), { launchUrl: Promise.resolve(`http://127.0.0.1:${String(spec.port)}/?token=fake-launch-token`) })
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

async function gatewayFixture(role: 'user' | 'admin' = 'user', maxActiveRuntimes = 2, profileManager?: PublicProfile): Promise<{ gateway: Gateway; base: string; auth: AuthStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-multiuser-gateway-'))
  resources.push({ close: () => rm(dir, { recursive: true, force: true }) })
  const auth = new AuthStore(join(dir, 'gateway.sqlite'))
  resources.push(auth)
  if (role === 'admin') await auth.createUser({ username: role, displayName: role, password: 'correct horse battery staple', role })
  const runtimes = new RuntimeManager({ dataRoot: join(dir, 'users'), maxActiveRuntimes, idleMs: 1_800_000, processProvider: new FakeRuntimeProvider(), portAllocator: freePort, recordSink: record => auth.upsertRuntimeRecord(record), healthCheck: async spec => { const response = await fetch(`http://127.0.0.1:${String(spec.port)}/`); return response.ok }, ...(profileManager === undefined ? {} : { environment: { SSH_CONNECTION: 'dsh-multiuser-embedded-browser' } }) })
  resources.push(runtimes)
  const gatewayPort = await freePort()
  const publicMcp = new PublicMcpStore(join(dir, 'public-mcp.cordis.yml'))
  await publicMcp.initialize()
  const gateway = new Gateway({ auth, runtimes, port: gatewayPort, secureCookies: false, allowedHosts: [`127.0.0.1:${String(gatewayPort)}`], globalConfig: new GlobalConfigStore(join(dir, 'gateway.env')), publicSkills: new PublicSkillStore(join(dir, 'public-agents')), publicMcp, sso: await ssoVerifier(), ...(profileManager === undefined ? {} : { profileManager }) })
  await gateway.start()
  gateways.push(gateway)
  return { gateway, base: `http://127.0.0.1:${String(gatewayPort)}`, auth }
}

async function login(base: string, username: string): Promise<string> {
  const subject = username === 'bob' ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111'
  const seconds = Math.floor(Date.now() / 1000)
  const token = await new SignJWT({ sub: subject, preferred_username: username, name: username, jti: randomUUID() })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: 'sso-2026-01' }).setIssuer('example-idp').setAudience('dsh-multiuser').setIssuedAt(seconds).setNotBefore(seconds).setExpirationTime(seconds + 60).sign(signingKey!)
  const response = await fetch(`${base}/auth/sso`, { method: 'POST', redirect: 'manual', headers: { origin: 'http://127.0.0.1:8000', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) })
  expect(response.status).toBe(303)
  const cookie = response.headers.get('set-cookie')
  expect(cookie).toBeTruthy()
  return cookie!.split(';', 1)[0]!
}

async function adminLogin(base: string): Promise<string> {
  const response = await fetch(`${base}/admin/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }) })
  expect(response.status).toBe(200)
  return response.headers.get('set-cookie')!.split(';', 1)[0]!
}

function rawStatus(base: string, headers: Record<string, string>): Promise<number> {
  const url = new URL('/auth/me', base)
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: Number(url.port), path: url.pathname, headers }, response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    request.once('error', reject)
    request.end()
  })
}

describe('gateway policy', () => {
  it('gives administrators a smaller read-only method set', () => {
    expect(isAllowedAdminRpc('session/list')).toBe(true)
    expect(isAllowedAdminRpc('session/history')).toBe(true)
    expect(isAllowedAdminRpc('session.prompt')).toBe(false)
    expect(isAllowedAdminRpc('session.export')).toBe(false)
    expect(isAllowedAdminRpc('settings.describe')).toBe(false)
    expect(adminSessionRpc('session/list', {})).toEqual({ method: 'session/list', args: { _request: {} } })
    expect(adminSessionRpc('session/history', { sessionId: 'session-1', throughSeq: 42, maxMessages: 20 })).toEqual({
      method: 'session/page',
      args: { request: { address: { kind: 'session', sessionId: 'session-1' }, throughSeq: 42, maxMessages: 20 } },
    })
    expect(() => adminSessionRpc('session/history', { sessionId: 'session-1', maxMessages: 20 })).toThrow('throughSeq')
  })

  it('authenticates, proxies the user runtime, and denies credential access', async () => {
    const { base } = await gatewayFixture()
    const loginPage = await fetch(`${base}/`, { redirect: 'manual' })
    expect(loginPage.status).toBe(302)
    expect(loginPage.headers.get('location')).toBe('/admin/login')
    const cookie = await login(base, 'user')
    const page = await fetch(`${base}/`, { headers: { cookie } })
    expect(await page.text()).toContain('runtime')
    expect(await (await fetch(`${base}/`, { headers: { cookie } })).text()).toContain('当前用户：user (sso-user)')
    const rpc = await fetch(`${base}/api/session/list`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: {} }) })
    expect(rpc.status).toBe(200)
    expect(await rpc.json()).toMatchObject({ result: { ok: true } })
    const credentials = await fetch(`${base}/api/credentials.describe`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'credentials.describe', payload: {} }) })
    expect(credentials.status).toBe(200)
    const outside = await fetch(`${base}/api/session.create`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r3', method: 'session.create', payload: { cwd: '/tmp/other-user' } }) })
    expect(outside.status).toBe(200)
    const otherWorkspace = await fetch(`${base}/api/session.create`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r3b', method: 'session.create', payload: { workspaceId: 'other-workspace' } }) })
    expect(otherWorkspace.status).toBe(200)
    const attachment = await fetch(`${base}/api/session.attachment`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r4', method: 'session.attachment', payload: {} }) })
    expect(attachment.status).toBe(200)
    const exportResponse = await fetch(`${base}/api/session.export?sessionId=own`, { headers: { cookie } })
    expect(exportResponse.status).toBe(200)
    expect((await fetch(`${base}/download/file`, { headers: { cookie } })).status).toBe(200)
    expect(JSON.stringify((await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json()))).not.toContain('password')
  })

  it('rejects untrusted Host and Origin headers before authentication', async () => {
    const { base } = await gatewayFixture()
    expect(await rawStatus(base, { host: 'evil.example' })).toBe(421)
    expect((await fetch(`${base}/auth/me`, { headers: { origin: 'http://evil.example' } })).status).toBe(403)
  })

  it('rejects malformed cookies without turning them into a server error', async () => {
    const { base } = await gatewayFixture()
    const response = await fetch(`${base}/auth/me`, { headers: { cookie: 'dsh_multiuser_session=%E0%A4%A' } })
    expect(response.status).toBe(401)
  })

  it('isolates two users by principal directory and runtime', async () => {
    const { base, auth } = await gatewayFixture()
    const aliceCookie = await login(base, 'user')
    const bobCookie = await login(base, 'bob')
    await fetch(`${base}/`, { headers: { cookie: aliceCookie } })
    await fetch(`${base}/`, { headers: { cookie: bobCookie } })
    const users = auth.listUsers()
    expect(users).toHaveLength(2)
    const records = auth.listRuntimeRecords()
    expect(records).toHaveLength(2)
    expect(records[0]?.userId).not.toBe(records[1]?.userId)
    const paths = runtimeParentEnv({ DEEPSEEK_API_KEY: 'key', OTHER_SECRET: 'hidden', PATH: '/bin' })
    expect(paths).toMatchObject({ DEEPSEEK_API_KEY: 'key', PATH: '/bin' })
    expect(paths).not.toHaveProperty('OTHER_SECRET')
    expect(users[0]?.id).not.toBe(users[1]?.id)
  })

  it('revokes a disabled user cookie while preserving its data record', async () => {
    const { base, auth } = await gatewayFixture()
    const cookie = await login(base, 'user')
    const user = auth.listUsers().find(item => item.authSource === 'sso')!
    auth.disableUser(user.id)
    expect((await fetch(`${base}/auth/me`, { headers: { cookie } })).status).toBe(401)
    const disabledUserPage = await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' })
    expect(disabledUserPage.status).toBe(302)
    expect(disabledUserPage.headers.get('location')).toBe('/admin/login')
    expect(auth.getUser(user.id)).toMatchObject({ id: user.id, enabled: false })
  })

  it('returns service unavailable at the active-runtime limit without stopping the first user', async () => {
    const { base, auth } = await gatewayFixture('user', 1)
    const firstCookie = await login(base, 'user')
    expect((await fetch(`${base}/`, { headers: { cookie: firstCookie } })).status).toBe(200)
    const secondCookie = await login(base, 'bob')
    const response = await fetch(`${base}/`, { headers: { cookie: secondCookie } })
    expect(response.status).toBe(503)
    expect(auth.listRuntimeRecords().filter(record => record.status === 'RUNNING')).toHaveLength(1)
  })

  it('marks persisted active runtime records stale before a replacement gateway starts', async () => {
    const { auth } = await gatewayFixture()
    const user = await auth.findOrCreateExternalUser({ issuer: 'example-idp', subject: '11111111-1111-4111-8111-111111111111', username: 'user', displayName: 'user' })
    auth.upsertRuntimeRecord({ userId: user.id, status: 'RUNNING', pid: 999, port: 4999, launchId: 'old', lastActiveAt: Date.now() })
    expect(auth.listRuntimeRecords()[0]).toMatchObject({ status: 'RUNNING', pid: 999 })
    const replacement = new Gateway({ auth, runtimes: new RuntimeManager({ dataRoot: '/tmp/dsh-multiuser-test-users', maxActiveRuntimes: 1, idleMs: 1000, processProvider: new FakeRuntimeProvider(), portAllocator: freePort, healthCheck: async () => true }), port: 0, secureCookies: false, allowedHosts: ['127.0.0.1:0'] })
    resources.push(replacement)
    expect(auth.listRuntimeRecords()[0]).toMatchObject({ status: 'STOPPED', recentError: expect.stringContaining('gateway restarted') })
  })

  it('provides administrator runtime and read-only session endpoints', async () => {
    const { base, auth } = await gatewayFixture('admin')
    const cookie = await adminLogin(base)
    expect((await fetch(`${base}/`, { headers: { cookie } })).status).toBe(200)
    const users = await fetch(`${base}/admin/users`, { headers: { cookie } })
    expect(users.status).toBe(200)
    const userId = (await users.json()).users[0].user.id as string
    const page = await fetch(`${base}/admin`, { headers: { cookie } })
    expect(await page.text()).toContain('DSH 管理控制台')
    expect(await (await fetch(`${base}/admin`, { headers: { cookie } })).text()).toContain('关闭会话详情')
    const config = await fetch(`${base}/admin/global-config`, { headers: { cookie } })
    expect(await config.json()).toEqual({ apiKeyConfigured: false })
    const updated = await fetch(`${base}/admin/global-config`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'shared-key', baseUrl: 'https://example.test' }) })
    expect(await updated.json()).toEqual({ apiKeyConfigured: true, baseUrl: 'https://example.test' })
    expect(auth.listAudit()).toContainEqual(expect.objectContaining({ action: 'admin.global-model.save', result: 'success' }))
    const started = await fetch(`${base}/admin/runtime/${encodeURIComponent(userId)}/start`, { method: 'POST', headers: { cookie } })
    expect(started.status).toBe(200)
    const history = await fetch(`${base}/admin/sessions/${encodeURIComponent(userId)}/list`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })
    expect(history.status).toBe(200)
    const detail = await fetch(`${base}/admin/sessions/${encodeURIComponent(userId)}/history`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-1', throughSeq: 42, maxMessages: 20 }) })
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({ result: { ok: true, value: { records: [{ event: { type: 'user/message' } }] } } })
    const invalidDetail = await fetch(`${base}/admin/sessions/${encodeURIComponent(userId)}/history`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-1', maxMessages: 20 }) })
    expect(invalidDetail.status).toBe(400)
    const write = await fetch(`${base}/admin/sessions/${encodeURIComponent(userId)}/prompt`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })
    expect(write.status).toBe(404)
    const missingConfirm = await fetch(`${base}/admin/runtime/${encodeURIComponent(userId)}/stop`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })
    expect(missingConfirm.status).toBe(400)
    expect(auth.listAudit()).toContainEqual(expect.objectContaining({ action: 'admin.runtime.stop', result: 'failure' }))
  })

  it('uses the shared Profile manager for administrator plugin operations', async () => {
    const calls: string[] = []
    const profileManager: PublicProfile = {
      list: async () => ['@deepseek-ai/dsh-base'],
      add: async spec => { calls.push(`add:${spec}`) },
      remove: async name => { calls.push(`remove:${name}`) },
      install: async () => { calls.push('install') },
    }
    const { base } = await gatewayFixture('admin', 2, profileManager)
    const cookie = await adminLogin(base)
    expect(await (await fetch(`${base}/admin/public-plugins`, { headers: { cookie } })).json()).toEqual({ bundles: ['@deepseek-ai/dsh-base'] })
    for (const body of [{ action: 'add', spec: 'example-bundle' }, { action: 'install' }, { action: 'remove', name: 'example-bundle' }]) {
      expect((await fetch(`${base}/admin/public-plugins`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(200)
    }
    expect(calls).toEqual(['add:example-bundle', 'install', 'remove:example-bundle'])
  })

  it('manages public MCP servers without returning shared credentials', async () => {
    const { base, auth } = await gatewayFixture('admin')
    const cookie = await adminLogin(base)
    expect(await (await fetch(`${base}/admin/public-mcp`, { headers: { cookie } })).json()).toEqual({ servers: [] })

    const saved = await fetch(`${base}/admin/public-mcp`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ops', transport: 'streamable-http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer shared-secret' } }),
    })
    expect(saved.status).toBe(200)
    const savedBody = await saved.json()
    expect(savedBody).toMatchObject({ servers: [{ name: 'ops', serverName: 'public_ops', headerNames: ['Authorization'] }] })
    expect(JSON.stringify(savedBody)).not.toContain('shared-secret')
    expect(auth.listAudit()).toContainEqual(expect.objectContaining({ action: 'admin.public-mcp.save', target: 'ops', result: 'success' }))

    const removed = await fetch(`${base}/admin/public-mcp/ops`, { method: 'DELETE', headers: { cookie } })
    expect(await removed.json()).toEqual({ servers: [] })
    expect(auth.listAudit()).toContainEqual(expect.objectContaining({ action: 'admin.public-mcp.remove', target: 'ops', result: 'success' }))
  })

  it('imports complete public Skill packages through the administrator endpoint', async () => {
    const { base } = await gatewayFixture('admin')
    const cookie = await adminLogin(base)
    const response = await fetch(`${base}/admin/public-skills/import`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({
        name: 'release-check', files: [
          { path: 'SKILL.md', content: Buffer.from('---\nname: release-check\ndescription: Release checks\n---\n').toString('base64') },
          { path: 'scripts/check.sh', content: Buffer.from('echo ok\n').toString('base64') },
        ],
      }),
    })
    expect(response.status).toBe(200)
    expect(await (await fetch(`${base}/admin/public-skills`, { headers: { cookie } })).json()).toMatchObject({ skills: [{ name: 'release-check', files: ['SKILL.md', 'scripts/check.sh'] }] })
  })

  it('authenticates and forwards the unified Remote WebSocket channel', async () => {
    const { base } = await gatewayFixture()
    const cookie = await login(base, 'user')
    for (const path of ['/api/remote.mux']) {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`${base.replace(/^http/u, 'ws')}${path}`, { headers: { cookie } })
        socket.once('open', () => { socket.send('event-frame') })
        socket.once('message', (data, isBinary) => {
          expect(isBinary).toBe(true)
          expect(data.toString()).toBe('false:event-frame')
          socket.close()
        })
        socket.once('close', () => resolve())
        socket.once('error', reject)
      })
    }
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${base.replace(/^http/u, 'ws')}/api/events.mux`, { headers: { cookie } })
      socket.once('open', () => { socket.close(); reject(new Error('legacy event path was accepted')) })
      socket.once('error', () => resolve())
      socket.once('close', () => resolve())
    })
  })
})
