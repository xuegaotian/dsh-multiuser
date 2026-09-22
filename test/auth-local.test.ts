import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthStore } from '../src/auth-local.js'

const stores: AuthStore[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function store(): Promise<AuthStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-multiuser-auth-'))
  dirs.push(dir)
  const value = new AuthStore(join(dir, 'gateway.sqlite'), { now: () => 1_700_000_000_000 })
  stores.push(value)
  return value
}

describe('AuthStore', () => {
  it('creates a user and authenticates with an Argon2id password', async () => {
    const auth = await store()
    const user = await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'correct horse battery staple', role: 'user' })

    expect(user).toMatchObject({ username: 'alice', displayName: 'Alice', role: 'user', enabled: true })
    expect(user.id).not.toBe('alice')
    expect(await auth.authenticate('alice', 'wrong')).toBeUndefined()
    const login = await auth.authenticate('alice', 'correct horse battery staple')
    expect(login?.user.id).toBe(user.id)
    expect(login?.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(login?.expiresAt).toBe(1_700_000_000_000 + 8 * 60 * 60 * 1000)
  })

  it('validates, revokes, and expires login sessions', async () => {
    let now = 1_700_000_000_000
    const dir = await mkdtemp(join(tmpdir(), 'dsh-multiuser-auth-'))
    dirs.push(dir)
    const auth = new AuthStore(join(dir, 'gateway.sqlite'), { now: () => now })
    stores.push(auth)
    const user = await auth.createUser({ username: 'bob', displayName: 'Bob', password: 'a long enough password', role: 'user' })
    const login = await auth.authenticate('bob', 'a long enough password')
    expect(login).toBeDefined()
    expect(auth.getSession(login!.sessionId)?.user.id).toBe(user.id)
    auth.revokeSession(login!.sessionId)
    expect(auth.getSession(login!.sessionId)).toBeUndefined()

    const second = await auth.authenticate('bob', 'a long enough password')
    expect(second).toBeDefined()
    now += 8 * 60 * 60 * 1000 + 1
    expect(auth.getSession(second!.sessionId)).toBeUndefined()
  })

  it('disabling a user revokes every session and preserves the account record', async () => {
    const auth = await store()
    const user = await auth.createUser({ username: 'carol', displayName: 'Carol', password: 'a long enough password', role: 'admin' })
    const first = await auth.authenticate('carol', 'a long enough password')
    const second = await auth.authenticate('carol', 'a long enough password')
    auth.disableUser(user.id)

    expect(auth.getSession(first!.sessionId)).toBeUndefined()
    expect(auth.getSession(second!.sessionId)).toBeUndefined()
    expect(await auth.authenticate('carol', 'a long enough password')).toBeUndefined()
    expect(auth.listUsers()).toEqual([expect.objectContaining({ id: user.id, enabled: false })])
  })

  it('rejects duplicate usernames and weak passwords', async () => {
    const auth = await store()
    await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a long enough password', role: 'user' })
    await expect(auth.createUser({ username: 'alice', displayName: 'Other', password: 'a long enough password', role: 'user' })).rejects.toThrow(/username already exists/)
    await expect(auth.createUser({ username: 'bob', displayName: 'Bob', password: 'short', role: 'user' })).rejects.toThrow(/at least 12 characters/)
  })

  it('writes non-secret audit records for authentication and account changes', async () => {
    const auth = await store()
    const user = await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a long enough password', role: 'user' })
    await auth.authenticate('alice', 'wrong', { requestId: 'req-1', ip: '127.0.0.1' })
    await auth.authenticate('alice', 'a long enough password', { requestId: 'req-2', ip: '127.0.0.1' })
    auth.disableUser(user.id, { actorId: user.id, requestId: 'req-3' })
    const audit = auth.listAudit()
    expect(audit.map(entry => entry.action)).toEqual(['user.create', 'login.failure', 'login.success', 'user.disable'])
    expect(JSON.stringify(audit)).not.toContain('a long enough password')
  })

  it('rate-limits repeated failures by source and username', async () => {
    const auth = await store()
    await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a long enough password', role: 'user' })
    const request = { ip: '192.0.2.10' }
    for (let attempt = 0; attempt < 5; attempt += 1) expect(await auth.authenticate('alice', 'wrong', request)).toBeUndefined()
    expect(await auth.authenticate('alice', 'a long enough password', request)).toBeUndefined()
    expect(auth.listAudit().at(-1)).toMatchObject({ action: 'login.failure', detail: 'rate-limited' })
  })

  it('reserves failure capacity across concurrent user logins', async () => {
    const auth = await store()
    await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a long enough password', role: 'user' })
    const results = await Promise.all(Array.from({ length: 7 }, () => auth.authenticate('alice', 'wrong password', { ip: '192.0.2.20' })))

    expect(results).toHaveLength(7)
    expect(auth.listAudit().filter(entry => entry.action === 'login.failure' && entry.detail === 'invalid-credentials')).toHaveLength(5)
    expect(auth.listAudit().filter(entry => entry.action === 'login.failure' && entry.detail === 'rate-limited')).toHaveLength(2)
  })

  it('reserves failure capacity across concurrent administrator logins', async () => {
    const auth = await store()
    await auth.createUser({ username: 'admin', displayName: 'Admin', password: 'a long enough password', role: 'admin' })
    await Promise.all(Array.from({ length: 7 }, () => auth.authenticateAdmin('admin', 'wrong password', { ip: '192.0.2.21' })))

    expect(auth.listAudit().filter(entry => entry.action === 'admin.login.failure' && entry.detail === 'invalid-credentials')).toHaveLength(5)
    expect(auth.listAudit().filter(entry => entry.action === 'admin.login.failure' && entry.detail === 'rate-limited')).toHaveLength(2)
  })

  it('bounds failure windows and removes expired entries', async () => {
    let now = 1_700_000_000_000
    const dir = await mkdtemp(join(tmpdir(), 'dsh-multiuser-auth-'))
    dirs.push(dir)
    const auth = new AuthStore(join(dir, 'gateway.sqlite'), { now: () => now })
    stores.push(auth)

    await auth.authenticate('expired-user', 'wrong password', { ip: '192.0.2.10' })
    now += 15 * 60 * 1000
    await auth.authenticate('fresh-user', 'wrong password', { ip: '192.0.2.10' })
    const failures = (auth as unknown as { failures: Map<string, unknown> }).failures
    expect(failures.has('192.0.2.10:expired-user')).toBe(false)

    for (let index = 0; index < 4_200; index += 1) {
      await auth.authenticate(`unknown-${String(index).padStart(4, '0')}`, 'wrong password', { ip: '192.0.2.10' })
    }
    expect(failures.size).toBeLessThanOrEqual(4_096)
    const overflowFailures = (auth as unknown as { overflowFailures: Map<string, { count: number }> }).overflowFailures
    expect(overflowFailures.get('192.0.2.10')?.count).toBeGreaterThanOrEqual(5)
    expect(await auth.authenticate('untracked-admin', 'correct horse battery staple', { ip: '192.0.2.10' })).toBeUndefined()
    expect(auth.listAudit().at(-1)).toMatchObject({ action: 'login.failure', detail: 'rate-limited' })
  })

  it('keeps the fallback budget per client when the account map is full', async () => {
    const now = 1_700_000_000_000
    const dir = await mkdtemp(join(tmpdir(), 'dsh-multiuser-auth-'))
    dirs.push(dir)
    const auth = new AuthStore(join(dir, 'gateway.sqlite'), { now: () => now })
    stores.push(auth)
    const internal = auth as unknown as {
      failures: Map<string, { count: number; pending: number; startedAt: number }>
      overflowFailures: Map<string, { count: number }>
    }
    for (let index = 0; index < 4_096; index += 1) internal.failures.set(`203.0.113.7:filler-${String(index)}`, { count: 1, pending: 0, startedAt: now })
    await auth.createUser({ username: 'realuser', displayName: 'Real User', password: 'a long enough password', role: 'user' })

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await auth.authenticate(`fresh-${String(attempt)}`, 'wrong password', { ip: '203.0.113.7' })
    }
    expect(internal.overflowFailures.get('203.0.113.7')?.count).toBe(5)
    await auth.authenticate('another-fresh-name', 'wrong password', { ip: '203.0.113.7' })
    expect(auth.listAudit().at(-1)).toMatchObject({ action: 'login.failure', detail: 'rate-limited' })

    // An unrelated client must still be able to sign in while the flooding client is blocked.
    expect(await auth.authenticate('realuser', 'a long enough password', { ip: '198.51.100.77' })).toBeDefined()
  })

  it('does not refresh the shared fallback budget on a successful login', async () => {
    const now = 1_700_000_000_000
    const dir = await mkdtemp(join(tmpdir(), 'dsh-multiuser-auth-'))
    dirs.push(dir)
    const auth = new AuthStore(join(dir, 'gateway.sqlite'), { now: () => now })
    stores.push(auth)
    const internal = auth as unknown as {
      failures: Map<string, { count: number; pending: number; startedAt: number }>
      overflowFailures: Map<string, { count: number }>
    }
    for (let index = 0; index < 4_096; index += 1) internal.failures.set(`203.0.113.8:filler-${String(index)}`, { count: 1, pending: 0, startedAt: now })
    await auth.createUser({ username: 'realuser', displayName: 'Real User', password: 'a long enough password', role: 'user' })
    const request = { ip: '203.0.113.8' }

    for (let attempt = 0; attempt < 4; attempt += 1) await auth.authenticate(`fresh-${String(attempt)}`, 'wrong password', request)
    expect(internal.overflowFailures.get('203.0.113.8')?.count).toBe(4)

    // A valid credential must not buy fresh guesses for other accounts while the
    // shared fallback budget is in force.
    expect(await auth.authenticate('realuser', 'a long enough password', request)).toBeDefined()
    expect(internal.overflowFailures.get('203.0.113.8')?.count).toBe(4)

    await auth.authenticate('fifth-fresh-name', 'wrong password', request)
    expect(internal.overflowFailures.get('203.0.113.8')?.count).toBe(5)
    await auth.authenticate('sixth-fresh-name', 'wrong password', request)
    expect(auth.listAudit().at(-1)).toMatchObject({ action: 'login.failure', detail: 'rate-limited' })
  })

  it('resets the per-account window on a successful login', async () => {
    const auth = await store()
    await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a long enough password', role: 'user' })
    const request = { ip: '192.0.2.40' }
    for (let attempt = 0; attempt < 3; attempt += 1) await auth.authenticate('alice', 'wrong password', request)
    expect(await auth.authenticate('alice', 'a long enough password', request)).toBeDefined()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await auth.authenticate('alice', 'wrong password', request)).toBeUndefined()
    }
    expect(auth.listAudit().filter(entry => entry.action === 'login.failure' && entry.detail === 'invalid-credentials')).toHaveLength(8)
    expect(auth.listAudit().filter(entry => entry.action === 'login.failure' && entry.detail === 'rate-limited')).toHaveLength(0)
  })

  it('releases reserved capacity when authentication fails unexpectedly', async () => {
    const auth = await store()
    await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a long enough password', role: 'user' })
    const internal = auth as unknown as {
      failures: Map<string, { count: number; pending: number; startedAt: number }>
      db: { prepare: unknown }
    }
    const original = internal.db.prepare
    internal.db.prepare = () => { throw new Error('simulated storage failure') }
    await expect(auth.authenticate('alice', 'wrong password', { ip: '192.0.2.30' })).rejects.toThrow('simulated storage failure')
    internal.db.prepare = original

    expect(internal.failures.get('192.0.2.30:alice')?.pending).toBe(0)
    expect(await auth.authenticate('alice', 'a long enough password', { ip: '192.0.2.30' })).toBeDefined()
  })

  it('resets a password and revokes sessions issued under the old password', async () => {
    const auth = await store()
    const user = await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'old password long', role: 'user' })
    const login = await auth.authenticate('alice', 'old password long')
    await auth.resetPassword(user.id, 'new password long')
    expect(auth.getSession(login!.sessionId)).toBeUndefined()
    expect(await auth.authenticate('alice', 'old password long')).toBeUndefined()
    expect(await auth.authenticate('alice', 'new password long')).toBeDefined()
  })

  it('persists runtime control state and marks stale active rows after a gateway restart', async () => {
    const auth = await store()
    const user = await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a long enough password', role: 'user' })
    auth.upsertRuntimeRecord({ userId: user.id, status: 'RUNNING', pid: 123, port: 456, launchId: 'launch-1', startedAt: 1, lastActiveAt: 2 })
    expect(auth.listRuntimeRecords()).toMatchObject([{ userId: user.id, status: 'RUNNING', pid: 123, port: 456 }])
    auth.markRuntimeRecordsStale()
    expect(auth.listRuntimeRecords()).toMatchObject([{ userId: user.id, status: 'STOPPED', recentError: expect.stringContaining('gateway restarted') }])
  })

  it('migrates an unversioned legacy database without losing user, session, runtime, or audit rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-multiuser-auth-'))
    dirs.push(dir)
    const path = join(dir, 'gateway.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec("CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE login_sessions (session_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_access_at INTEGER NOT NULL, revoked_at INTEGER); CREATE TABLE runtime_records (user_id TEXT PRIMARY KEY, status TEXT NOT NULL, pid INTEGER, port INTEGER, launch_id TEXT, started_at INTEGER, last_active_at INTEGER, recent_error TEXT); CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target TEXT, occurred_at INTEGER NOT NULL, request_id TEXT, result TEXT NOT NULL, detail TEXT);")
    legacy.prepare("INSERT INTO users VALUES ('11111111-1111-4111-8111-111111111111', 'legacy', 'Legacy', 'hash', 'user', 1, 1, 1)").run()
    legacy.prepare("INSERT INTO login_sessions VALUES ('hash', '11111111-1111-4111-8111-111111111111', 1, 2, 1, NULL)").run()
    legacy.prepare("INSERT INTO runtime_records VALUES ('11111111-1111-4111-8111-111111111111', 'STOPPED', NULL, NULL, NULL, NULL, 1, NULL)").run()
    legacy.prepare("INSERT INTO audit_logs VALUES (1, NULL, 'legacy', NULL, 1, NULL, 'success', NULL)").run()
    legacy.close()
    const auth = new AuthStore(path)
    stores.push(auth)
    expect(auth.listUsers()).toEqual([expect.objectContaining({ username: 'legacy', authSource: 'local' })])
    expect(auth.listRuntimeRecords()).toHaveLength(1)
    expect(auth.listAudit()).toHaveLength(1)
    expect(auth.getSession('not-present')).toBeUndefined()
  })

  it('maps external identities by issuer and subject while keeping a user role and internal UUID', async () => {
    const auth = await store()
    const first = await auth.findOrCreateExternalUser({ issuer: 'example-idp', subject: '11111111-1111-4111-8111-111111111111', username: 'admin', displayName: 'Admin Name' })
    const refreshed = await auth.findOrCreateExternalUser({ issuer: 'example-idp', subject: '11111111-1111-4111-8111-111111111111', username: 'changed', displayName: 'Changed Name' })
    const second = await auth.findOrCreateExternalUser({ issuer: 'example-idp', subject: '22222222-2222-4222-8222-222222222222', username: 'admin', displayName: 'Second' })
    expect(first).toMatchObject({ role: 'user', authSource: 'sso' })
    expect(refreshed).toMatchObject({ id: first.id, displayName: 'Changed Name' })
    expect(second.id).not.toBe(first.id)
    expect(await auth.authenticateAdmin(first.username, 'any password')).toBeUndefined()
  })

  it('links only an unlinked local normal user and revokes its local sessions', async () => {
    const auth = await store()
    const local = await auth.createUser({ username: 'legacy', displayName: 'Legacy', password: 'a long enough password', role: 'user' })
    const session = await auth.authenticate('legacy', 'a long enough password')
    const linked = auth.linkExternalUser('legacy', 'example-idp', '11111111-1111-4111-8111-111111111111', 'sso-legacy')
    expect(linked).toMatchObject({ id: local.id, authSource: 'sso', role: 'user' })
    expect(auth.getSession(session!.sessionId)).toBeUndefined()
    await expect(auth.authenticate('legacy', 'a long enough password')).resolves.toBeUndefined()
  })
})
