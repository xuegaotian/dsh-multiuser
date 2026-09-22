import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as upstreamRequest } from 'node:http'
import { accessSync, constants, existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { join, resolve } from 'node:path'
import { URL } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'
import { adminPageHtml } from './admin-page.js'
import { adminLoginPageHtml } from './admin-login-page.js'
import { AuthStore, type User } from './auth-local.js'
import { GlobalConfigStore } from './global-config.js'
import { PublicSkillStore } from './public-content.js'
import { PublicMcpStore } from './public-mcp.js'
import type { PublicProfile } from './public-profile.js'
import { RuntimeManager, type RuntimeActivity, type RuntimeRecord } from './runtime-manager.js'
import { SsoVerifier } from './sso.js'

const COOKIE_NAME = 'dsh_multiuser_session'
const ADMIN_COOKIE_NAME = 'dsh_multiuser_admin_session'
const SSO_FORM_MAX_BYTES = 8 * 1024
const ADMIN_LOGIN_MAX_BYTES = 8 * 1024
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024

const ADMIN_RPC_ALLOWLIST = new Set(['session/list', 'session/search', 'session/history', 'subagent/list', 'subagent/history'])

export function isAllowedAdminRpc(method: string): boolean { return ADMIN_RPC_ALLOWLIST.has(method) }

/** Translate the administrator's stable read-only routes to current DSH Remote endpoints. */
export function adminSessionRpc(method: string, body: Record<string, unknown>): { method: string; args: Record<string, unknown> } {
  if (method === 'session/list') return { method, args: { _request: body } }
  if (method !== 'session/history') return { method, args: { request: body } }
  const { sessionId, throughSeq, beforeSeq, maxMessages } = body
  if (typeof sessionId !== 'string'
    || typeof throughSeq !== 'number'
    || !Number.isSafeInteger(throughSeq)
    || throughSeq < -1
    || (beforeSeq !== undefined
      && (typeof beforeSeq !== 'number' || !Number.isSafeInteger(beforeSeq) || beforeSeq < 0))
    || (maxMessages !== undefined
      && (typeof maxMessages !== 'number' || !Number.isSafeInteger(maxMessages) || maxMessages <= 0))) {
    throw new TypeError('sessionId, throughSeq, optional beforeSeq, and optional positive maxMessages are required')
  }
  return {
    method: 'session/page',
    args: {
      request: {
        address: { kind: 'session', sessionId },
        throughSeq,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        ...(maxMessages === undefined ? {} : { maxMessages }),
      },
    },
  }
}

/** A single readiness check result with a stable machine-readable code. */
export interface ReadinessCheck { code: string; ok: boolean; detail: string }

/** Aggregate readiness report returned by the injected readiness probe. */
export interface ReadinessReport { ok: boolean; checks: ReadinessCheck[] }

export interface GatewayOptions {
  auth: AuthStore
  runtimes: RuntimeManager
  host?: '127.0.0.1' | '0.0.0.0'
  port?: number
  allowedHosts: readonly string[]
  secureCookies?: boolean
  maxBodyBytes?: number
  workspaceRootForUser?: (userId: string) => string
  recoverStaleRuntimeRecords?: (records: readonly RuntimeRecord[]) => void
  globalConfig?: GlobalConfigStore
  publicSkills?: PublicSkillStore
  publicMcp?: PublicMcpStore
  profileManager?: PublicProfile
  sso?: SsoVerifier
  /** Non-sensitive readiness probe; when absent, /readyz reports unavailable. */
  readiness?: () => Promise<ReadinessReport>
  /** Non-sensitive build identity returned by /version. */
  versionInfo?: { name: string; version: string; commit: string | null; dsh: { tested: string[]; canary: string[] } }
}

interface SessionContext {
  user: User
  sessionId: string
}

interface GatewayRuntimeTarget {
  record: RuntimeRecord
  userId: string
  cookie: string
}

interface RuntimeAuthState {
  launchId: string
  cookie: string
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body)
}

function parseCookies(header: string | undefined): Map<string, string> {
  const values = new Map<string, string>()
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    try {
      values.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim()))
    } catch {
      // Ignore malformed cookies; an invalid session is equivalent to no session.
    }
  }
  return values
}

function requestId(req: IncomingMessage): string { return req.headers['x-request-id']?.toString() || randomUUID() }

function clientIp(req: IncomingMessage): string {
  const address = req.socket.remoteAddress
  return address === undefined ? 'unknown' : address
}

function writeError(res: ServerResponse, status: number, message: string): void {
  json(res, status, { error: message })
}

/** Single-host authenticated gateway for per-user DSH runtimes. */
export class Gateway {
  private readonly server: Server
  private readonly webSockets = new WebSocketServer({ noServer: true })
  private readonly options: Required<Pick<GatewayOptions, 'host' | 'port' | 'secureCookies' | 'maxBodyBytes'>> & GatewayOptions
  private listenedPort = 0
  private readonly runtimeAuth = new Map<string, RuntimeAuthState>()
  private draining = false

  constructor(options: GatewayOptions) {
    this.options = {
      host: options.host ?? '127.0.0.1', port: options.port ?? 0,
      secureCookies: options.secureCookies ?? true, maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      ...options,
    }
    this.options.recoverStaleRuntimeRecords?.(this.options.auth.listRuntimeRecords())
    this.options.auth.markRuntimeRecordsStale()
    this.server = createServer((req, res) => { void this.handle(req, res) })
    this.server.on('upgrade', (req, socket, head) => { void this.handleUpgrade(req, socket, head) })
  }

  /** Start listening and resolve the actual port. */
  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off('error', reject)
        this.listenedPort = (this.server.address() as AddressInfo).port
        resolve()
      })
    })
    return this.listenedPort
  }

  /** Mark the gateway as draining so /healthz stops reporting healthy. */
  beginShutdown(): void {
    this.draining = true
  }

  /** Close the gateway and all currently proxied WebSocket connections. */
  async close(): Promise<void> {
    this.beginShutdown()
    for (const client of this.webSockets.clients) client.close(1001, 'gateway stopping')
    this.webSockets.close()
    if (!this.server.listening) return
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  /** Actual bound port after {@link start}. */
  get port(): number { return this.listenedPort }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = requestId(req)
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      if (!this.hasTrustedHost(req)) { writeError(res, 421, 'untrusted host'); return }
      // Health/readiness/version endpoints are served before any session or
      // authentication check: they need no cookie, never proxy to a user
      // runtime, and never write audit logs. Untrusted Hosts still get 421.
      if (req.method === 'GET' && url.pathname === '/healthz') { this.serveHealthz(res); return }
      if (req.method === 'GET' && url.pathname === '/readyz') { await this.serveReadyz(res, id); return }
      if (req.method === 'GET' && url.pathname === '/version') { this.serveVersion(res); return }
      if (url.pathname === '/auth/sso' && req.method === 'POST') { await this.ssoLogin(req, res, id); return }
      if (!this.isTrustedRequest(req)) { writeError(res, 403, 'untrusted origin'); return }
      if (url.pathname === '/auth/logout' && req.method === 'POST') { await this.logout(req, res, id); return }
      if (url.pathname === '/auth/me' && req.method === 'GET') { this.me(req, res); return }
      if (url.pathname === '/admin/login' && req.method === 'GET') { this.adminLoginPage(res); return }
      if (url.pathname === '/admin/auth/login' && req.method === 'POST') { await this.adminLogin(req, res, id); return }
      if (url.pathname === '/admin/auth/logout' && req.method === 'POST') { await this.adminLogout(req, res, id); return }
      const session = this.userSession(req)
      if (url.pathname === '/' && req.method === 'GET') {
        if (session === undefined) this.redirectToAdminLogin(res)
        else await this.proxyHttp(req, res, session.user.id, url, 'browser', `${session.user.displayName} (${session.user.username})`)
        return
      }
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        const admin = this.adminSession(req)
        if (admin === undefined) { this.redirectToAdminLogin(res); return }
        await this.admin(req, res, url, admin, id); return
      }
      if (session === undefined) { writeError(res, 401, 'authentication required'); return }
      if (url.pathname.startsWith('/api/')) {
        await this.userApi(req, res, url, session, id); return
      }
      await this.proxyHttp(req, res, session.user.id, url)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = message.includes('maxActiveRuntimes') ? 503 : 500
      if (!res.headersSent) writeError(res, status, message)
      else res.destroy()
    }
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!this.isTrustedRequest(req)) { socket.destroy(); return }
    const session = this.userSession(req)
    if (session === undefined) { socket.destroy(); return }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (url.pathname !== '/api/remote.mux') { socket.destroy(); return }
    try {
      const target = await this.ensureRuntime(session.user.id)
      const upstream = new WebSocket(`ws://127.0.0.1:${String(target.record.port)}${url.pathname}`, { headers: { host: `127.0.0.1:${String(target.record.port)}`, cookie: target.cookie } })
      upstream.once('open', () => {
        this.webSockets.handleUpgrade(req, socket, head, client => {
          this.webSockets.emit('connection', client, req)
          this.options.runtimes.setActivity(session.user.id, 'browser', this.options.runtimes.activityCount(session.user.id, 'browser') + 1)
          let closed = false
          const close = (): void => {
            if (closed) return
            closed = true
            this.options.runtimes.setActivity(session.user.id, 'browser', Math.max(0, this.options.runtimes.activityCount(session.user.id, 'browser') - 1))
            upstream.close()
          }
          client.on('message', (data, isBinary) => {
            if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
          })
          upstream.on('message', (data, isBinary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary }) })
          client.on('close', close)
          upstream.on('close', close)
          client.on('error', close)
          upstream.on('error', close)
        })
      })
      upstream.once('error', () => { socket.destroy() })
    } catch { socket.destroy() }
  }

  private async adminLogin(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    let body: Record<string, unknown>
    try { body = await readJson(req, ADMIN_LOGIN_MAX_BYTES) } catch (error) {
      const status = error instanceof Error && error.message === 'request body too large' ? 413 : 400
      writeError(res, status, status === 413 ? 'request body too large' : 'invalid login request')
      return
    }
    if (typeof body !== 'object' || body === null || typeof body.username !== 'string' || typeof body.password !== 'string') { writeError(res, 400, 'username and password are required'); return }
    const result = await this.options.auth.authenticateAdmin(body.username, body.password, { requestId: id, ip: clientIp(req) })
    if (result === undefined) { writeError(res, 401, 'invalid credentials'); return }
    const flags = [`${ADMIN_COOKIE_NAME}=${encodeURIComponent(result.sessionId)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${String(Math.floor((result.expiresAt - Date.now()) / 1000))}`]
    if (this.options.secureCookies) flags.push('Secure')
    json(res, 200, { user: result.user }, { 'set-cookie': flags.join('; ') })
  }

  private async logout(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const session = this.userSession(req)
    if (session !== undefined) this.options.auth.revokeSession(session.sessionId, { actorId: session.user.id, requestId: id })
    json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax` })
  }

  private async adminLogout(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const session = this.adminSession(req)
    if (session !== undefined) this.options.auth.revokeSession(session.sessionId, { actorId: session.user.id, requestId: id })
    json(res, 200, { ok: true }, { 'set-cookie': `${ADMIN_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax` })
  }

  private async ssoLogin(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const verifier = this.options.sso
    if (verifier === undefined) { writeError(res, 404, 'not found'); return }
    if (req.headers.origin !== verifier.allowedOrigin) { writeError(res, 403, 'untrusted origin'); return }
    let form: { token: string }
    try {
      form = await readForm(req, SSO_FORM_MAX_BYTES)
    } catch (error) {
      const status = error instanceof Error && error.message === 'request body too large' ? 413 : 400
      writeError(res, status, status === 413 ? 'request body too large' : 'invalid sign-in form')
      return
    }
    let identity
    try { identity = await verifier.verify(form.token) } catch { writeError(res, 401, 'invalid or expired sign-in token'); return }
    if (!verifier.consume(identity.tokenId, identity.expiresAt)) { writeError(res, 401, 'invalid or expired sign-in token'); return }
    try {
      const user = await this.options.auth.findOrCreateExternalUser({ issuer: identity.issuer, subject: identity.subject, username: identity.username, displayName: identity.displayName }, { requestId: id })
      if (!user.enabled || user.role !== 'user' || user.authSource !== 'sso') { this.options.auth.recordAudit('sso.login.denied', user.id, 'failure', { requestId: id }); writeError(res, 403, 'sign-in is not permitted'); return }
      const session = this.options.auth.createSession(user.id, 'sso')
      const flags = [`${COOKIE_NAME}=${encodeURIComponent(session.sessionId)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${String(Math.floor((session.expiresAt - Date.now()) / 1000))}`]
      if (this.options.secureCookies) flags.push('Secure')
      res.writeHead(303, { location: '/', 'set-cookie': flags.join('; '), 'cache-control': 'no-store', pragma: 'no-cache', 'referrer-policy': 'no-referrer' })
      res.end()
    } catch { writeError(res, 500, 'sign-in could not be completed') }
  }

  private me(req: IncomingMessage, res: ServerResponse): void {
    const session = this.userSession(req)
    if (session === undefined) { writeError(res, 401, 'authentication required'); return }
    json(res, 200, { user: session.user })
  }

  private async userApi(req: IncomingMessage, res: ServerResponse, url: URL, session: SessionContext, id: string): Promise<void> {
    if (url.pathname === '/api/session.export' && (req.method === 'GET' || req.method === 'HEAD')) {
      await this.proxyHttp(req, res, session.user.id, url, 'file')
      return
    }
    if (req.method !== 'POST') {
      await this.proxyHttp(req, res, session.user.id, url)
      return
    }
    const body = await readJson(req, this.options.maxBodyBytes)
    const method = typeof body === 'object' && body !== null && typeof body.method === 'string' ? body.method : undefined
    await this.proxyJson(req, res, session.user.id, url, body, method === undefined ? undefined : this.activityForRpc(method))
  }

  private async admin(req: IncomingMessage, res: ServerResponse, url: URL, session: SessionContext, id: string): Promise<void> {
    if (session.user.role !== 'admin') { this.options.auth.recordAudit('admin.denied', session.user.id, 'failure', { actorId: session.user.id, requestId: id }); writeError(res, 403, 'administrator role required'); return }
    if ((url.pathname === '/admin' || url.pathname === '/admin/') && req.method === 'GET') { this.adminPage(res); return }
    if (url.pathname === '/admin/global-config' && req.method === 'GET') {
      if (this.options.globalConfig === undefined) { writeError(res, 404, 'global configuration is not enabled'); return }
      json(res, 200, await this.options.globalConfig.describe()); return
    }
    if (url.pathname === '/admin/global-config' && req.method === 'PUT') {
      if (this.options.globalConfig === undefined) { writeError(res, 404, 'global configuration is not enabled'); return }
      const body = await readJson(req, 4096)
      if (typeof body.apiKey !== 'string' || (body.baseUrl !== undefined && typeof body.baseUrl !== 'string') || (body.providers !== undefined && !Array.isArray(body.providers))) { writeError(res, 400, 'apiKey, optional baseUrl, and providers are required'); return }
      const value = await this.options.globalConfig.save({ apiKey: body.apiKey, ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}), ...(Array.isArray(body.providers) ? { providers: body.providers as never } : {}) })
      await this.options.runtimes.stopAll()
      this.options.auth.recordAudit('admin.global-model.save', undefined, 'success', { actorId: session.user.id, requestId: id })
      json(res, 200, value); return
    }
    if (url.pathname === '/admin/public-skills' && req.method === 'GET') {
      if (this.options.publicSkills === undefined) { writeError(res, 404, 'public skills are not enabled'); return }
      json(res, 200, { root: this.options.publicSkills.path(), skills: await this.options.publicSkills.list() }); return
    }
    if (url.pathname === '/admin/public-plugins' && req.method === 'GET') {
      if (this.options.profileManager === undefined) { writeError(res, 404, 'public profile is not enabled'); return }
      json(res, 200, { bundles: await this.options.profileManager.list() }); return
    }
    if (url.pathname === '/admin/public-mcp' && req.method === 'GET') {
      if (this.options.publicMcp === undefined) { writeError(res, 404, 'public MCP is not enabled'); return }
      json(res, 200, { servers: await this.options.publicMcp.list() }); return
    }
    if (url.pathname === '/admin/public-mcp' && req.method === 'PUT') {
      if (this.options.publicMcp === undefined) { writeError(res, 404, 'public MCP is not enabled'); return }
      const body = await readJson(req, 64 * 1024)
      const servers = await this.options.publicMcp.save(body)
      await this.options.runtimes.stopAll()
      const target = typeof body.name === 'string' ? body.name : undefined
      this.options.auth.recordAudit('admin.public-mcp.save', target, 'success', { actorId: session.user.id, requestId: id })
      json(res, 200, { servers }); return
    }
    if (url.pathname.startsWith('/admin/public-mcp/') && req.method === 'DELETE') {
      if (this.options.publicMcp === undefined) { writeError(res, 404, 'public MCP is not enabled'); return }
      const name = decodeURIComponent(url.pathname.slice('/admin/public-mcp/'.length))
      const servers = await this.options.publicMcp.remove(name)
      await this.options.runtimes.stopAll()
      this.options.auth.recordAudit('admin.public-mcp.remove', name, 'success', { actorId: session.user.id, requestId: id })
      json(res, 200, { servers }); return
    }
    if (url.pathname === '/admin/public-plugins' && req.method === 'POST') {
      if (this.options.profileManager === undefined) { writeError(res, 404, 'public profile is not enabled'); return }
      const body = await readJson(req, 8192)
      if (body.action === 'install') await this.options.profileManager.install()
      else if (body.action === 'add' && typeof body.spec === 'string') await this.options.profileManager.add(body.spec)
      else if (body.action === 'remove' && typeof body.name === 'string') await this.options.profileManager.remove(body.name)
      else { writeError(res, 400, 'supported actions are add, remove, and install'); return }
      this.options.auth.recordAudit('admin.public-plugin.update', typeof body.spec === 'string' ? body.spec : typeof body.name === 'string' ? body.name : 'install', 'success', { actorId: session.user.id, requestId: id })
      json(res, 200, { bundles: await this.options.profileManager.list() }); return
    }
    if (url.pathname === '/admin/public-skills' && req.method === 'PUT') {
      if (this.options.publicSkills === undefined) { writeError(res, 404, 'public skills are not enabled'); return }
      const body = await readJson(req, this.options.maxBodyBytes)
      if (typeof body.name !== 'string' || typeof body.content !== 'string') { writeError(res, 400, 'name and content are required'); return }
      await this.options.publicSkills.save(body.name, body.content)
      this.options.auth.recordAudit('admin.public-skill.save', body.name, 'success', { actorId: session.user.id, requestId: id })
      json(res, 200, { ok: true }); return
    }
    if (url.pathname === '/admin/public-skills/import' && req.method === 'PUT') {
      if (this.options.publicSkills === undefined) { writeError(res, 404, 'public skills are not enabled'); return }
      const body = await readJson(req, this.options.maxBodyBytes)
      if (typeof body.name !== 'string' || !Array.isArray(body.files) || !body.files.every(file => typeof file === 'object' && file !== null && typeof file.path === 'string' && typeof file.content === 'string')) { writeError(res, 400, 'name and base64 files are required'); return }
      await this.options.publicSkills.import(body.name, body.files as Array<{ path: string; content: string }>)
      this.options.auth.recordAudit('admin.public-skill.import', body.name, 'success', { actorId: session.user.id, requestId: id })
      json(res, 200, { ok: true }); return
    }
    const skill = /^\/admin\/public-skills\/([a-z0-9-]+)$/u.exec(url.pathname)
    if (skill !== null && req.method === 'DELETE') {
      if (this.options.publicSkills === undefined) { writeError(res, 404, 'public skills are not enabled'); return }
      await this.options.publicSkills.remove(skill[1]!)
      this.options.auth.recordAudit('admin.public-skill.delete', skill[1], 'success', { actorId: session.user.id, requestId: id })
      json(res, 200, { ok: true }); return
    }
    if (url.pathname === '/admin/users' && req.method === 'GET') {
      const persisted = new Map(this.options.auth.listRuntimeRecords().map(record => [record.userId, record]))
      const users = this.options.auth.listUsers().map(user => ({ user, runtime: this.options.runtimes.get(user.id) ?? persisted.get(user.id) ?? { userId: user.id, status: 'STOPPED', lastActiveAt: 0 } }))
      this.options.auth.recordAudit('admin.users', session.user.id, 'success', { actorId: session.user.id, requestId: id })
      json(res, 200, { users }); return
    }
    if (url.pathname === '/admin/users' && req.method === 'POST') {
      const body = await readJson(req, 4096)
      if (typeof body.username !== 'string' || typeof body.displayName !== 'string' || typeof body.password !== 'string') { writeError(res, 400, 'username, displayName, and password are required'); return }
      try {
        const user = await this.options.auth.createUser({ username: body.username, displayName: body.displayName, password: body.password, role: 'user' }, { actorId: session.user.id, requestId: id })
        json(res, 201, { user })
      } catch (error) { writeError(res, 400, error instanceof Error ? error.message : String(error)) }
      return
    }
    const userDelete = /^\/admin\/users\/([^/]+)$/u.exec(url.pathname)
    if (userDelete !== null && req.method === 'DELETE') {
      const userId = decodeURIComponent(userDelete[1]!)
      const user = this.options.auth.getUser(userId)
      if (user === undefined) { writeError(res, 404, 'user not found'); return }
      if (user.role !== 'user') { writeError(res, 400, 'administrator accounts cannot be deleted'); return }
      await this.options.runtimes.stop(userId)
      this.options.auth.deleteUser(userId, { actorId: session.user.id, requestId: id })
      json(res, 200, { ok: true }); return
    }
    const start = /^\/admin\/runtime\/([^/]+)\/start$/u.exec(url.pathname)
    if (start !== null && req.method === 'POST') {
      const userId = decodeURIComponent(start[1]!)
      if (this.options.auth.getUser(userId)?.enabled !== true) {
        this.options.auth.recordAudit('admin.runtime.start', userId, 'failure', { actorId: session.user.id, requestId: id }, 'user not found or disabled')
        writeError(res, 404, 'user not found or disabled'); return
      }
      const record = await this.ensureRuntime(userId)
      this.options.auth.recordAudit('admin.runtime.start', userId, 'success', { actorId: session.user.id, requestId: id })
      json(res, 200, { runtime: record }); return
    }
    const stop = /^\/admin\/runtime\/([^/]+)\/stop$/u.exec(url.pathname)
    if (stop !== null && req.method === 'POST') {
      const userId = decodeURIComponent(stop[1]!)
      const body = await readJson(req, 4096)
      if (typeof body !== 'object' || body === null || body.confirm !== true) {
        this.options.auth.recordAudit('admin.runtime.stop', userId, 'failure', { actorId: session.user.id, requestId: id }, 'confirm=true is required')
        writeError(res, 400, 'confirm=true is required'); return
      }
      if (this.options.auth.getUser(userId) === undefined) {
        this.options.auth.recordAudit('admin.runtime.stop', userId, 'failure', { actorId: session.user.id, requestId: id }, 'user not found')
        writeError(res, 404, 'user not found'); return
      }
      await this.options.runtimes.stop(userId)
      this.options.auth.recordAudit('admin.runtime.stop', userId, 'success', { actorId: session.user.id, requestId: id })
      json(res, 200, { runtime: this.options.runtimes.get(userId) }); return
    }
    const rpc = /^\/admin\/sessions\/([^/]+)\/(list|search|history)$/u.exec(url.pathname)
    if (rpc !== null && req.method === 'POST') {
      const userId = decodeURIComponent(rpc[1]!)
      const method = `session/${rpc[2]!}`
      if (!isAllowedAdminRpc(method)) { writeError(res, 403, 'admin RPC method is not allowed'); return }
      if (this.options.auth.getUser(userId)?.enabled !== true) {
        this.options.auth.recordAudit('admin.session.read', userId, 'failure', { actorId: session.user.id, requestId: id }, 'user not found or disabled')
        writeError(res, 404, 'user not found or disabled'); return
      }
      const body = await readJson(req, this.options.maxBodyBytes)
      let target: ReturnType<typeof adminSessionRpc>
      try { target = adminSessionRpc(method, body) } catch (error) {
        writeError(res, 400, error instanceof Error ? error.message : String(error)); return
      }
      await this.ensureRuntime(userId)
      await this.proxyJson(req, res, userId, new URL(`/api/${target.method}`, url), { type: 'client-request', method: target.method, rpcId: randomUUID(), payload: { args: target.args } })
      this.options.auth.recordAudit('admin.session.read', userId, 'success', { actorId: session.user.id, requestId: id }, `method=${method}`)
      return
    }
    if (url.pathname.startsWith('/admin/sessions/')) this.options.auth.recordAudit('admin.rpc.denied', session.user.id, 'failure', { actorId: session.user.id, requestId: id }, `path=${url.pathname}`)
    writeError(res, 404, 'admin route not found')
  }

  private async proxyJson(req: IncomingMessage, res: ServerResponse, userId: string, url: URL, body: unknown, activity?: RuntimeActivity): Promise<void> {
    const target = await this.ensureRuntime(userId)
    const payload = JSON.stringify(body)
    await this.proxyRequest(req, res, userId, activity, () => {
      const proxy = upstreamRequest({ hostname: '127.0.0.1', port: target.record.port, path: url.pathname + url.search, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), host: `127.0.0.1:${String(target.record.port)}`, cookie: target.cookie } }, upstream => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers)
        upstream.pipe(res)
      })
      proxy.on('error', error => { if (!res.headersSent) writeError(res, 502, error.message); else res.destroy() })
      proxy.end(payload)
      return proxy
    })
  }

  private async proxyHttp(_req: IncomingMessage, res: ServerResponse, userId: string, url: URL, activity: RuntimeActivity = 'browser', identityLabel?: string): Promise<void> {
    const target = await this.ensureRuntime(userId)
    await this.proxyRequest(_req, res, userId, activity, () => {
      const proxy = upstreamRequest({ hostname: '127.0.0.1', port: target.record.port, path: url.pathname + url.search, method: _req.method, headers: { ..._req.headers, host: `127.0.0.1:${String(target.record.port)}`, cookie: target.cookie, connection: 'close' } }, upstream => {
        if (identityLabel === undefined) {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers)
          upstream.pipe(res)
          return
        }
        const chunks: Buffer[] = []
        upstream.on('data', chunk => chunks.push(Buffer.from(chunk)))
        upstream.once('end', () => {
          const headers = { ...upstream.headers }
          delete headers['content-length']
          const encoded = identityLabel.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
          const badge = `<aside aria-label="当前用户" style="position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:6px 10px;border:1px solid #d0d7de;border-radius:6px;background:#fff;color:#24292f;font:12px system-ui,sans-serif;box-shadow:0 1px 3px #0002">当前用户：${encoded}</aside>`
          const html = Buffer.concat(chunks).toString('utf8')
          res.writeHead(upstream.statusCode ?? 502, headers)
          res.end(html.includes('</body>') ? html.replace('</body>', `${badge}</body>`) : `${html}${badge}`)
        })
      })
      proxy.on('error', error => { if (!res.headersSent) writeError(res, 502, error.message); else res.destroy() })
      _req.pipe(proxy)
      return proxy
    })
  }

  private async proxyRequest<T extends { once(event: string, listener: (...args: never[]) => void): T }>(req: IncomingMessage, res: ServerResponse, userId: string, activity: RuntimeActivity | undefined, create: () => T): Promise<void> {
    if (activity !== undefined) this.options.runtimes.setActivity(userId, activity, this.options.runtimes.activityCount(userId, activity) + 1)
    await new Promise<void>(resolve => {
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        if (activity !== undefined) this.options.runtimes.setActivity(userId, activity, Math.max(0, this.options.runtimes.activityCount(userId, activity) - 1))
        resolve()
      }
      const proxy = create()
      proxy.once('close', release)
      req.once('aborted', release)
      res.once('close', release)
    })
  }

  private activityForRpc(method: string): RuntimeActivity | undefined {
    if (method === 'session.prompt' || method === 'subagent.prompt') return 'agent'
    if (method === 'session.attachment') return 'file'
    return undefined
  }

  private userSession(req: IncomingMessage): SessionContext | undefined {
    const raw = parseCookies(req.headers.cookie).get(COOKIE_NAME)
    if (raw === undefined || raw === '') return undefined
    const session = this.options.auth.getSession(raw, 'sso')
    return session === undefined ? undefined : { user: session.user, sessionId: raw }
  }

  private adminSession(req: IncomingMessage): SessionContext | undefined {
    const raw = parseCookies(req.headers.cookie).get(ADMIN_COOKIE_NAME)
    if (raw === undefined || raw === '') return undefined
    const session = this.options.auth.getSession(raw, 'local')
    return session === undefined || session.user.role !== 'admin' || session.user.authSource !== 'local' ? undefined : { user: session.user, sessionId: raw }
  }

  private async ensureRuntime(userId: string): Promise<GatewayRuntimeTarget> {
    const record = await this.options.runtimes.ensureRunning(userId)
    if (record.port === undefined) throw new Error('runtime has no internal port')
    if (record.launchId === undefined) throw new Error('runtime has no launch identity')
    const current = this.runtimeAuth.get(userId)
    if (current?.launchId === record.launchId) return { record, userId, cookie: current.cookie }
    const launchUrl = await this.options.runtimes.launchUrl(userId)
    const exchanged = await fetch(launchUrl, { redirect: 'manual' })
    if (exchanged.status !== 303) throw new Error(`runtime authentication exchange failed (${String(exchanged.status)})`)
    const setCookie = exchanged.headers.get('set-cookie')
    if (setCookie === null) throw new Error('runtime authentication exchange omitted Set-Cookie')
    const cookie = setCookie.split(';', 1)[0]
    if (cookie === undefined || !/^dsh-auth-[A-Za-z0-9_-]+=v1\./u.test(cookie)) throw new Error('runtime authentication exchange returned an invalid Cookie')
    this.runtimeAuth.set(userId, { launchId: record.launchId, cookie })
    return { record, userId, cookie }
  }

  private hasTrustedHost(req: IncomingMessage): boolean {
    const host = req.headers.host
    return host !== undefined && this.options.allowedHosts.includes(host)
  }

  private isTrustedRequest(req: IncomingMessage): boolean {
    if (!this.hasTrustedHost(req)) return false
    const origin = req.headers.origin
    if (origin === undefined) return true
    try { return this.options.allowedHosts.includes(new URL(origin).host) } catch { return false }
  }

  private serveHealthz(res: ServerResponse): void {
    if (this.draining) { json(res, 503, { status: 'draining' }); return }
    json(res, 200, { status: 'ok' })
  }

  private async serveReadyz(res: ServerResponse, id: string): Promise<void> {
    const readiness = this.options.readiness
    if (readiness === undefined) {
      json(res, 503, { status: 'not-ready', checks: [{ code: 'READINESS_UNAVAILABLE', ok: false, detail: 'readiness probe is not configured' }] })
      return
    }
    const shaped = await this.shapeReadiness(readiness, id)
    if (shaped === undefined) {
      json(res, 503, { status: 'not-ready', checks: [{ code: 'READINESS_PROBE_FAILED', ok: false, detail: 'readiness probe failed' }] })
      return
    }
    json(res, shaped.ok ? 200 : 503, { status: shaped.ok ? 'ready' : 'not-ready', checks: shaped.checks })
  }

  /**
   * Shape a readiness report for anonymous consumption. Returns `undefined` for
   * every failure mode — a probe that throws, a probe that rejects, and a probe
   * that resolves with a malformed report. Shaping stays inside the guard because
   * an exception escaping here would reach the top-level handler, which echoes the
   * raw `error.message` to an unauthenticated caller.
   */
  private async shapeReadiness(readiness: () => Promise<ReadinessReport>, id: string): Promise<{ ok: boolean; checks: Array<{ code: string; ok: boolean; detail: string }> } | undefined> {
    try {
      const report = await readiness()
      return { ok: report.ok === true, checks: report.checks.map(check => ({ code: check.code, ok: check.ok, detail: publicReadinessDetail(check.code, check.ok) })) }
    } catch (error) {
      console.error('readiness probe failed', { requestId: id, error })
      return undefined
    }
  }

  private serveVersion(res: ServerResponse): void {
    const info = this.options.versionInfo
    const body = info === undefined
      ? { name: 'dsh-multiuser', version: 'unknown', commit: null, dsh: { tested: [], canary: [] }, node: process.version }
      : { name: info.name, version: info.version, commit: info.commit, dsh: { tested: info.dsh.tested, canary: info.dsh.canary }, node: process.version }
    json(res, 200, body)
  }

  private adminPage(res: ServerResponse): void {
    const html = adminPageHtml()
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  }

  private adminLoginPage(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(adminLoginPageHtml())
  }

  private redirectToAdminLogin(res: ServerResponse): void {
    res.writeHead(302, { location: '/admin/login', 'cache-control': 'no-store' })
    res.end()
  }
}

function publicReadinessDetail(code: string, ok: boolean): string {
  switch (code) {
    case 'DB': return ok ? 'database is ready' : 'database is unavailable'
    case 'PROFILE_TEMPLATE': return ok ? 'profile template is ready' : 'profile template is unavailable'
    case 'PROFILE_TEMPLATE_MISSING': return 'profile template is unavailable'
    case 'DSH_VERSION': return 'dsh version is supported'
    case 'DSH_VERSION_UNSUPPORTED': return 'dsh version is unsupported'
    case 'READINESS_UNAVAILABLE': return 'readiness probe is not configured'
    default: return ok ? 'readiness check passed' : 'readiness check failed'
  }
}

async function readForm(req: IncomingMessage, maxBytes: number): Promise<{ token: string }> {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/x-www-form-urlencoded') throw new Error('invalid form')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
  const entries = [...fields.entries()]
  if (entries.length !== 1 || entries[0]![0] !== 'token' || entries[0]![1] === '') throw new Error('invalid form')
  return { token: entries[0]![1] }
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('JSON object required')
  return value as Record<string, unknown>
}

export interface ReadinessProbeOptions {
  /** Absolute or relative SQLite database path. */
  db: string
  /** Per-user data root (profile template lives under <dataRoot>/profile-template). */
  dataRoot: string
  /** DSH profile name whose template package.json is verified. */
  profile: string
  /** Tested DSH versions from compatibility.json. */
  testedDshVersions: readonly string[]
  /** Injected DSH version resolver; must not be called on every probe (cached). */
  runDshVersion: () => Promise<string | undefined>
  /** Injectable clock (ms) for cache TTL; defaults to Date.now. */
  clock?: () => number
  /** Cache lifetime in ms; defaults to 60s. */
  cacheMs?: number
}

/**
 * Build a readiness probe with a fixed 60s cache so each Kubernetes probe does
 * not re-spawn the DSH process. The probe never starts a user runtime nor talks
 * to a model provider. Check order is fixed: DB, PROFILE_TEMPLATE, DSH_VERSION.
 */
export function createReadinessProbe(options: ReadinessProbeOptions): () => Promise<ReadinessReport> {
  const cacheMs = options.cacheMs ?? 60_000
  const clock = options.clock ?? (() => Date.now())
  let cachedAt = -Infinity
  let cached: ReadinessReport | undefined
  return async (): Promise<ReadinessReport> => {
    if (cached !== undefined && clock() - cachedAt < cacheMs) return cached
    const checks = await Promise.all([
      dbCheck(resolve(options.db)),
      profileTemplateCheck(resolve(options.dataRoot), options.profile),
      dshVersionCheck(options.testedDshVersions, options.runDshVersion),
    ])
    const report: ReadinessReport = { ok: checks.every(check => check.ok), checks }
    cached = report
    cachedAt = clock()
    return report
  }
}

async function dbCheck(dbPath: string): Promise<ReadinessCheck> {
  if (!existsSync(dbPath)) return { code: 'DB', ok: false, detail: `database file does not exist: ${dbPath}` }
  try {
    accessSync(dbPath, constants.R_OK | constants.W_OK)
    const store = new AuthStore(dbPath)
    try { store.listUsers() } finally { store.close() }
    return { code: 'DB', ok: true, detail: `database is readable and writable: ${dbPath}` }
  } catch (error) {
    return { code: 'DB', ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function profileTemplateCheck(dataRoot: string, profile: string): ReadinessCheck {
  const manifest = join(dataRoot, 'profile-template', 'profiles', profile, 'package.json')
  return existsSync(manifest)
    ? { code: 'PROFILE_TEMPLATE', ok: true, detail: `profile template is present: ${manifest}` }
    : { code: 'PROFILE_TEMPLATE_MISSING', ok: false, detail: `profile template is missing: ${manifest}` }
}

async function dshVersionCheck(testedDshVersions: readonly string[], runDshVersion: () => Promise<string | undefined>): Promise<ReadinessCheck> {
  const version = await runDshVersion()
  if (version === undefined) {
    return { code: 'DSH_VERSION_UNSUPPORTED', ok: false, detail: 'could not determine the DSH version' }
  }
  if (testedDshVersions.includes(version)) {
    return { code: 'DSH_VERSION', ok: true, detail: `dsh ${version} is a tested version` }
  }
  return { code: 'DSH_VERSION_UNSUPPORTED', ok: false, detail: `dsh ${version} is not a tested version (tested: ${testedDshVersions.join(', ')})` }
}
