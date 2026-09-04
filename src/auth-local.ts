import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import argon2 from 'argon2'

export type Role = 'user' | 'admin'
export type AuthSource = 'local' | 'sso'

export interface User {
  id: string
  username: string
  displayName: string
  role: Role
  enabled: boolean
  createdAt: number
  updatedAt: number
  authSource: AuthSource
}

export interface LoginResult {
  sessionId: string
  expiresAt: number
  user: User
}

export interface AuditEntry {
  id: number
  actorId?: string
  action: string
  target?: string
  occurredAt: number
  requestId?: string
  result: 'success' | 'failure'
  detail?: string
}

export interface RuntimeRecordEntry {
  userId: string
  status: 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'FAILED'
  pid?: number | undefined
  port?: number | undefined
  launchId?: string | undefined
  startedAt?: number | undefined
  lastActiveAt: number
  recentError?: string | undefined
}

export interface AuthStoreOptions {
  now?: () => number
  sessionTtlMs?: number
  maxLoginFailures?: number
  loginWindowMs?: number
  ssoSessionTtlMs?: number
}

interface UserRow {
  id: string
  username: string
  display_name: string
  password_hash: string
  role: Role
  enabled: number
  created_at: number
  updated_at: number
  auth_source: AuthSource
  external_issuer: string | null
  external_subject: string | null
  external_username: string | null
}

interface SessionRow {
  session_hash: string
  user_id: string
  expires_at: number
  revoked_at: number | null
  session_auth_source: AuthSource
}

interface AuditRow {
  id: number
  actor_id: string | null
  action: string
  target: string | null
  occurred_at: number
  request_id: string | null
  result: 'success' | 'failure'
  detail: string | null
}

interface RuntimeRow {
  user_id: string
  status: RuntimeRecordEntry['status']
  pid: number | null
  port: number | null
  launch_id: string | null
  started_at: number | null
  last_active_at: number | null
  recent_error: string | null
}

interface FailureWindow {
  count: number
  startedAt: number
}

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000
const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000
const DEFAULT_MAX_LOGIN_FAILURES = 5
const DEFAULT_SSO_SESSION_TTL_MS = 60 * 60 * 1000
const SCHEMA_VERSION = 2
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function normalizedUsername(username: string): string {
  const value = username.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(value)) {
    throw new Error('username must contain 3-64 lowercase letters, numbers, dots, underscores, or hyphens')
  }
  return value
}

function validatePassword(password: string): void {
  if (password.length < 12) throw new Error('password must contain at least 12 characters')
  if (password.length > 1024) throw new Error('password must contain at most 1024 characters')
}

function hashSession(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex')
}

function publicUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    authSource: row.auth_source,
  }
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed')
}

/** Local account, session, and minimum audit persistence for the gateway. */
export class AuthStore {
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly sessionTtlMs: number
  private readonly maxLoginFailures: number
  private readonly loginWindowMs: number
  private readonly ssoSessionTtlMs: number
  private readonly failures = new Map<string, FailureWindow>()

  constructor(path: string, options: AuthStoreOptions = {}) {
    this.db = new DatabaseSync(path)
    this.now = options.now ?? Date.now
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.maxLoginFailures = options.maxLoginFailures ?? DEFAULT_MAX_LOGIN_FAILURES
    this.loginWindowMs = options.loginWindowMs ?? DEFAULT_LOGIN_WINDOW_MS
    this.ssoSessionTtlMs = options.ssoSessionTtlMs ?? DEFAULT_SSO_SESSION_TTL_MS
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    this.migrate()
  }

  private migrate(): void {
    const declaredVersion = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    const hasUsersTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() !== undefined
    const version = declaredVersion === 0 && hasUsersTable ? 1 : declaredVersion
    if (version > SCHEMA_VERSION) throw new Error(`database schema version ${String(version)} is newer than this gateway supports`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (version === 0) this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'admin')), enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        auth_source TEXT NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local', 'sso')),
        external_issuer TEXT, external_subject TEXT, external_username TEXT
      );
      CREATE TABLE IF NOT EXISTS login_sessions (
        session_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, last_access_at INTEGER NOT NULL, revoked_at INTEGER,
        auth_source TEXT NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local', 'sso'))
      );
      CREATE TABLE IF NOT EXISTS runtime_records (user_id TEXT PRIMARY KEY REFERENCES users(id), status TEXT NOT NULL, pid INTEGER, port INTEGER, launch_id TEXT, started_at INTEGER, last_active_at INTEGER, recent_error TEXT);
      CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT REFERENCES users(id), action TEXT NOT NULL, target TEXT, occurred_at INTEGER NOT NULL, request_id TEXT, result TEXT NOT NULL CHECK (result IN ('success', 'failure')), detail TEXT);
      CREATE INDEX IF NOT EXISTS login_sessions_user_idx ON login_sessions(user_id);
      CREATE INDEX IF NOT EXISTS audit_logs_time_idx ON audit_logs(occurred_at);
      CREATE UNIQUE INDEX IF NOT EXISTS users_external_identity_idx ON users(external_issuer, external_subject) WHERE external_issuer IS NOT NULL AND external_subject IS NOT NULL;
      PRAGMA user_version = 2;`)
      else if (version === 1) this.db.exec(`
      ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local', 'sso'));
      ALTER TABLE users ADD COLUMN external_issuer TEXT;
      ALTER TABLE users ADD COLUMN external_subject TEXT;
      ALTER TABLE users ADD COLUMN external_username TEXT;
      ALTER TABLE login_sessions ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local', 'sso'));
      CREATE UNIQUE INDEX users_external_identity_idx ON users(external_issuer, external_subject) WHERE external_issuer IS NOT NULL AND external_subject IS NOT NULL;
      PRAGMA user_version = 2;`)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /** Close the database handle. */
  close(): void { this.db.close() }

  /** Create an enabled local account with an immutable internal id. */
  async createUser(input: { username: string; displayName: string; password: string; role: Role }, audit: { actorId?: string; requestId?: string } = {}): Promise<User> {
    const username = normalizedUsername(input.username)
    validatePassword(input.password)
    const displayName = input.displayName.trim()
    if (displayName.length === 0 || displayName.length > 120) throw new Error('display name must contain 1-120 characters')
    const timestamp = this.now()
    const row = {
      id: randomUUID(), username, display_name: displayName,
      password_hash: await argon2.hash(input.password, { type: argon2.argon2id }),
      role: input.role, enabled: 1, created_at: timestamp, updated_at: timestamp, auth_source: 'local' as const,
      external_issuer: null, external_subject: null, external_username: null,
    }
    try {
      this.db.prepare('INSERT INTO users (id, username, display_name, password_hash, role, enabled, created_at, updated_at, auth_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, row.username, row.display_name, row.password_hash, row.role, row.enabled, row.created_at, row.updated_at, row.auth_source)
    } catch (error) {
      if (isConstraintError(error)) throw new Error('username already exists')
      throw error
    }
    this.audit('user.create', row.id, 'success', audit, `username=${username};role=${input.role}`)
    return publicUser(row)
  }

  /** List accounts without password hashes or session values. */
  listUsers(): User[] {
    const rows = this.db.prepare('SELECT id, username, display_name, password_hash, role, enabled, created_at, updated_at, auth_source, external_issuer, external_subject, external_username FROM users ORDER BY username').all() as unknown as UserRow[]
    return rows.map(publicUser)
  }

  /** Resolve one account by immutable principal id without exposing credentials. */
  getUser(userId: string): User | undefined {
    const row = this.db.prepare('SELECT id, username, display_name, password_hash, role, enabled, created_at, updated_at, auth_source, external_issuer, external_subject, external_username FROM users WHERE id = ?').get(userId) as unknown as UserRow | undefined
    return row === undefined ? undefined : publicUser(row)
  }

  /** Persist Runtime control state; the row is never treated as process proof. */
  upsertRuntimeRecord(record: RuntimeRecordEntry): void {
    this.db.prepare(`INSERT INTO runtime_records (user_id, status, pid, port, launch_id, started_at, last_active_at, recent_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, pid=excluded.pid, port=excluded.port,
      launch_id=excluded.launch_id, started_at=excluded.started_at, last_active_at=excluded.last_active_at, recent_error=excluded.recent_error`)
      .run(record.userId, record.status, record.pid ?? null, record.port ?? null, record.launchId ?? null, record.startedAt ?? null, record.lastActiveAt, record.recentError ?? null)
  }

  /** Read persisted Runtime control rows for administrative display. */
  listRuntimeRecords(): RuntimeRecordEntry[] {
    const rows = this.db.prepare('SELECT user_id, status, pid, port, launch_id, started_at, last_active_at, recent_error FROM runtime_records ORDER BY user_id').all() as unknown as RuntimeRow[]
    return rows.map(row => ({
      userId: row.user_id, status: row.status, lastActiveAt: row.last_active_at ?? 0,
      ...(row.pid === null ? {} : { pid: row.pid }),
      ...(row.port === null ? {} : { port: row.port }),
      ...(row.launch_id === null ? {} : { launchId: row.launch_id }),
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.recent_error === null ? {} : { recentError: row.recent_error }),
    }))
  }

  /** Mark records from a previous gateway process as stale control state. */
  markRuntimeRecordsStale(): void {
    this.db.prepare(`UPDATE runtime_records SET status = 'STOPPED', pid = NULL, port = NULL,
      recent_error = CASE WHEN status IN ('STARTING', 'RUNNING', 'STOPPING')
        THEN 'gateway restarted; runtime requires a fresh health check' ELSE recent_error END
      WHERE status IN ('STARTING', 'RUNNING', 'STOPPING')`).run()
  }

  /** Authenticate a password and mint a raw session id for an HttpOnly cookie. */
  async authenticate(usernameInput: string, password: string, request: { requestId?: string; ip?: string } = {}): Promise<LoginResult | undefined> {
    const username = normalizedUsername(usernameInput)
    const key = `${request.ip ?? 'unknown'}:${username}`
    if (this.isRateLimited(key)) {
      this.audit('login.failure', username, 'failure', request, 'rate-limited')
      return undefined
    }
    const row = this.db.prepare("SELECT id, username, display_name, password_hash, role, enabled, created_at, updated_at, auth_source, external_issuer, external_subject, external_username FROM users WHERE username = ? AND auth_source = 'local'").get(username) as unknown as UserRow | undefined
    const valid = row !== undefined && row.enabled === 1 && await argon2.verify(row.password_hash, password).catch(() => false)
    if (!valid) {
      this.recordFailure(key)
      this.audit('login.failure', row?.id ?? username, 'failure', request, 'invalid-credentials')
      return undefined
    }
    this.failures.delete(key)
    const sessionId = randomBytes(32).toString('base64url')
    const timestamp = this.now()
    const expiresAt = timestamp + this.sessionTtlMs
    this.db.prepare("INSERT INTO login_sessions (session_hash, user_id, created_at, expires_at, last_access_at, auth_source) VALUES (?, ?, ?, ?, ?, 'local')")
      .run(hashSession(sessionId), row.id, timestamp, expiresAt, timestamp)
    this.audit('login.success', row.id, 'success', request)
    return { sessionId, expiresAt, user: publicUser(row) }
  }

  /** Authenticate only an enabled local administrator and mint an administrator session. */
  async authenticateAdmin(usernameInput: string, password: string, request: { requestId?: string; ip?: string } = {}): Promise<LoginResult | undefined> {
    const username = normalizedUsername(usernameInput)
    const key = `${request.ip ?? 'unknown'}:${username}`
    if (this.isRateLimited(key)) { this.audit('admin.login.failure', username, 'failure', request, 'rate-limited'); return undefined }
    const row = this.db.prepare("SELECT id, username, display_name, password_hash, role, enabled, created_at, updated_at, auth_source, external_issuer, external_subject, external_username FROM users WHERE username = ? AND auth_source = 'local' AND role = 'admin' AND enabled = 1").get(username) as unknown as UserRow | undefined
    const valid = row !== undefined && await argon2.verify(row.password_hash, password).catch(() => false)
    if (!valid) { this.recordFailure(key); this.audit('admin.login.failure', row?.id ?? username, 'failure', request, 'invalid-credentials'); return undefined }
    this.failures.delete(key)
    const result = this.createSession(row.id, 'local')
    this.audit('admin.login.success', row.id, 'success', request)
    return { ...result, user: publicUser(row) }
  }

  /** Find or create an SSO user by immutable issuer and subject only. */
  async findOrCreateExternalUser(input: { issuer: string; subject: string; username: string; displayName: string }, audit: { actorId?: string; requestId?: string } = {}): Promise<User> {
    const displayName = input.displayName.trim()
    const externalUsername = input.username.trim()
    if (input.issuer === '' || input.subject === '' || externalUsername === '' || externalUsername.length > 64 || displayName === '' || [...displayName].length > 120) throw new Error('external identity is invalid')
    const passwordHash = await argon2.hash(randomBytes(32).toString('base64url'), { type: argon2.argon2id })
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.externalUser(input.issuer, input.subject)
      if (existing !== undefined) {
        this.db.prepare('UPDATE users SET external_username = ?, display_name = ?, updated_at = ? WHERE id = ?').run(externalUsername, displayName, this.now(), existing.id)
        const refreshed = this.getUser(existing.id)!
        this.db.exec('COMMIT')
        this.audit('sso.user.refresh', existing.id, 'success', audit)
        return refreshed
      }
      const timestamp = this.now()
      const id = randomUUID()
      const username = this.externalInternalUsername(externalUsername, input.subject)
      this.db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, enabled, created_at, updated_at, auth_source, external_issuer, external_subject, external_username) VALUES (?, ?, ?, ?, 'user', 1, ?, ?, 'sso', ?, ?, ?)")
        .run(id, username, displayName, passwordHash, timestamp, timestamp, input.issuer, input.subject, externalUsername)
      const created = this.getUser(id)!
      this.db.exec('COMMIT')
      this.audit('sso.user.create', id, 'success', audit)
      return created
    } catch (error) {
      this.db.exec('ROLLBACK')
      if (isConstraintError(error)) {
        const existing = this.externalUser(input.issuer, input.subject)
        if (existing !== undefined) return existing
      }
      throw error
    }
  }

  /** Create a source-bound opaque session without checking a password. */
  createSession(userId: string, source: AuthSource, expiresAt?: number): { sessionId: string; expiresAt: number } {
    const sessionId = randomBytes(32).toString('base64url')
    const timestamp = this.now()
    const expiry = expiresAt ?? timestamp + (source === 'sso' ? this.ssoSessionTtlMs : this.sessionTtlMs)
    if (expiry <= timestamp) throw new Error('session expiry must be in the future')
    this.db.prepare('INSERT INTO login_sessions (session_hash, user_id, created_at, expires_at, last_access_at, auth_source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hashSession(sessionId), userId, timestamp, expiry, timestamp, source)
    return { sessionId, expiresAt: expiry }
  }

  /** Bind one local normal user to an immutable SSO issuer+subject and revoke local sessions. */
  linkExternalUser(localUsername: string, issuer: string, subject: string, externalUsername: string, audit: { actorId?: string; requestId?: string } = {}): User {
    const username = normalizedUsername(localUsername)
    const external = externalUsername.trim()
    if (issuer.trim() === '' || !UUID.test(subject) || external === '' || [...external].length > 64) throw new Error('external identity is invalid')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare("SELECT id, username, display_name, password_hash, role, enabled, created_at, updated_at, auth_source, external_issuer, external_subject, external_username FROM users WHERE username = ?").get(username) as unknown as UserRow | undefined
      if (row === undefined) throw new Error('user not found')
      if (row.auth_source !== 'local' || row.role !== 'user') throw new Error('only unlinked local normal users can be linked')
      if (this.externalUser(issuer, subject) !== undefined) throw new Error('external subject is already linked')
      const timestamp = this.now()
      this.db.prepare("UPDATE users SET auth_source = 'sso', external_issuer = ?, external_subject = ?, external_username = ?, updated_at = ? WHERE id = ?").run(issuer, subject, external, timestamp, row.id)
      this.db.prepare('UPDATE login_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(timestamp, row.id)
      const linked = this.getUser(row.id)!
      this.db.exec('COMMIT')
      this.audit('sso.user.link', row.id, 'success', audit)
      return linked
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /** Resolve a session cookie and refresh its last-access timestamp. */
  getSession(sessionId: string, source?: AuthSource): { user: User; expiresAt: number } | undefined {
    const row = this.db.prepare(`SELECT s.session_hash, s.user_id, s.expires_at, s.revoked_at, s.auth_source AS session_auth_source, u.id, u.username, u.display_name, u.password_hash, u.role, u.enabled, u.created_at, u.updated_at, u.auth_source, u.external_issuer, u.external_subject, u.external_username
      FROM login_sessions s JOIN users u ON u.id = s.user_id WHERE s.session_hash = ?`).get(hashSession(sessionId)) as unknown as (SessionRow & UserRow) | undefined
    if (row === undefined || (source !== undefined && row.session_auth_source !== source) || row.revoked_at !== null || row.expires_at <= this.now() || row.enabled !== 1) return undefined
    this.db.prepare('UPDATE login_sessions SET last_access_at = ? WHERE session_hash = ?').run(this.now(), row.session_hash)
    return { user: publicUser(row), expiresAt: row.expires_at }
  }

  /** Revoke one session without exposing whether it existed. */
  revokeSession(sessionId: string, audit: { actorId?: string; requestId?: string } = {}): void {
    this.db.prepare('UPDATE login_sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL').run(this.now(), hashSession(sessionId))
    this.audit('session.revoke', undefined, 'success', audit)
  }

  /** Disable an account and revoke every currently issued session. */
  disableUser(userId: string, audit: { actorId?: string; requestId?: string } = {}): void {
    const timestamp = this.now()
    const result = this.db.prepare('UPDATE users SET enabled = 0, updated_at = ? WHERE id = ?').run(timestamp, userId)
    if (Number(result.changes) === 0) throw new Error('user not found')
    this.db.prepare('UPDATE login_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(timestamp, userId)
    this.audit('user.disable', userId, 'success', audit)
  }

  /** Permanently remove a normal user account and its login/runtime records. */
  deleteUser(userId: string, audit: { actorId?: string; requestId?: string } = {}): void {
    const user = this.getUser(userId)
    if (user === undefined) throw new Error('user not found')
    if (user.role !== 'user') throw new Error('administrator accounts cannot be deleted')
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM login_sessions WHERE user_id = ?').run(userId)
      this.db.prepare('DELETE FROM runtime_records WHERE user_id = ?').run(userId)
      this.db.prepare('DELETE FROM users WHERE id = ?').run(userId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.audit('user.delete', userId, 'success', audit)
  }

  /** Replace a password and revoke all existing sessions for the account. */
  async resetPassword(userId: string, password: string, audit: { actorId?: string; requestId?: string } = {}): Promise<void> {
    validatePassword(password)
    const timestamp = this.now()
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
    const result = this.db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND auth_source = 'local'").run(passwordHash, timestamp, userId)
    if (Number(result.changes) === 0) throw new Error('user not found')
    this.db.prepare('UPDATE login_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(timestamp, userId)
    this.audit('user.password-reset', userId, 'success', audit)
  }

  /** Read audit metadata for administrative review; secrets are never stored here. */
  listAudit(): AuditEntry[] {
    const rows = this.db.prepare('SELECT id, actor_id, action, target, occurred_at, request_id, result, detail FROM audit_logs ORDER BY id').all() as unknown as AuditRow[]
    return rows.map(row => ({
      id: row.id, action: row.action, occurredAt: row.occurred_at, result: row.result,
      ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
      ...(row.target === null ? {} : { target: row.target }),
      ...(row.request_id === null ? {} : { requestId: row.request_id }),
      ...(row.detail === null ? {} : { detail: row.detail }),
    }))
  }

  /** Append one non-secret audit event for gateway authorization decisions. */
  recordAudit(action: string, target: string | undefined, result: 'success' | 'failure', request: { actorId?: string; requestId?: string }, detail?: string): void {
    this.audit(action, target, result, request, detail)
  }

  private audit(action: string, target: string | undefined, result: 'success' | 'failure', request: { actorId?: string; requestId?: string }, detail?: string): void {
    this.db.prepare('INSERT INTO audit_logs (actor_id, action, target, occurred_at, request_id, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(request.actorId ?? null, action, target ?? null, this.now(), request.requestId ?? null, result, detail ?? null)
  }

  private externalUser(issuer: string, subject: string): User | undefined {
    const row = this.db.prepare("SELECT id, username, display_name, password_hash, role, enabled, created_at, updated_at, auth_source, external_issuer, external_subject, external_username FROM users WHERE external_issuer = ? AND external_subject = ?").get(issuer, subject) as unknown as UserRow | undefined
    return row === undefined ? undefined : publicUser(row)
  }

  private externalInternalUsername(username: string, subject: string): string {
    const base = username.toLowerCase().replace(/[^a-z0-9._-]/gu, '-').replace(/^[^a-z0-9]+/u, '').slice(0, 48) || 'user'
    const prefix = `sso-${base}`.slice(0, 55).replace(/[-._]+$/u, '')
    const candidate = normalizedUsername(prefix.length >= 3 ? prefix : 'sso-user')
    const occupied = this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate)
    if (occupied === undefined) return candidate
    return normalizedUsername(`${candidate.slice(0, 55)}-${createHash('sha256').update(subject).digest('hex').slice(0, 8)}`)
  }

  private isRateLimited(key: string): boolean {
    const window = this.failures.get(key)
    if (window === undefined) return false
    if (this.now() - window.startedAt >= this.loginWindowMs) {
      this.failures.delete(key)
      return false
    }
    return window.count >= this.maxLoginFailures
  }

  private recordFailure(key: string): void {
    const timestamp = this.now()
    const window = this.failures.get(key)
    if (window === undefined || timestamp - window.startedAt >= this.loginWindowMs) {
      this.failures.set(key, { count: 1, startedAt: timestamp })
    } else window.count += 1
  }
}
