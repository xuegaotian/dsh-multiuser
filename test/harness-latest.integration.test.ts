import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { prepareUserProfile } from '../src/user-profile.js'

/**
 * Real DeepSeek Harness integration tests.
 *
 * These tests boot actual `dsh` processes through the published npm CLI and
 * verify the wire contract this Gateway depends on: the launch-token exchange,
 * the authority-bound `dsh-auth-*` cookie, the `/api` RPC envelope, and the
 * `/api/remote.mux` WebSocket. They never use a fake runtime provider.
 *
 * Select the DSH installation with `DSH_INTEGRATION_BIN` (an absolute path to
 * a `dsh` executable). A common setup is:
 *
 * ```sh
 * mkdir -p compat-work && cd compat-work
 * npm install --save-exact @deepseek-ai/dsh@0.1.5-rc.2
 * DSH_INTEGRATION_BIN="$PWD/node_modules/.bin/dsh" pnpm test:integration
 * ```
 *
 * Every test home lives under a temporary directory, so the maintainer's
 * default `DSH_HOME` is never read or written.
 */
const dshBin = process.env.DSH_INTEGRATION_BIN
const dshVersion = process.env.DSH_INTEGRATION_VERSION

interface RuntimeHandle {
  port: number
  cookie: string
  stop(): Promise<void>
}

const temporaryRoots: string[] = []
const children: Array<ReturnType<typeof spawn>> = []

/**
 * Stop one spawned runtime and wait until it is reaped.
 *
 * `exitCode` stays `null` when a process dies from a signal, so both fields have
 * to be checked: otherwise a second stop would wait for an `exit` event that has
 * already fired and hang the teardown forever. Awaiting the exit before removing
 * the home also matters — deleting a tree while the runtime still writes into it
 * makes the removal arbitrarily slow.
 */
function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()) })
  child.kill('SIGTERM')
  return exited
}

afterAll(async () => {
  await Promise.all(children.map(child => stopChild(child)))
  await Promise.all(temporaryRoots.map(root => rm(root, { recursive: true, force: true })))
})

const dshBinExists = dshBin !== undefined && existsSync(dshBin)
const describeIntegration = dshBinExists ? describe : describe.skip

function projectRoot(): string {
  return resolve(import.meta.dirname, '..')
}

/** Spawn one real DSH runtime with a dedicated home and capture its launch URL. */
async function startRuntime(workspace: string, home: string): Promise<RuntimeHandle> {
  const child = spawn(dshBin!, ['--profile', 'user-runtime', '--no-open', '--port', '0'], {
    cwd: workspace,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_RUNTIME_WORKSPACE: workspace,
      SSH_CONNECTION: 'dsh-multiuser-embedded-browser',
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let output = ''
  let launchUrl: string | undefined
  let exited = false
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
    const match = /dsh web: (https?:\/\/[^\s()]+\?token=[A-Za-z0-9_-]{43})/u.exec(output)
    if (match !== null && launchUrl === undefined) launchUrl = match[1]
  })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  child.once('exit', () => { exited = true })
  const start = Date.now()
  while (launchUrl === undefined && !exited && Date.now() - start < 90_000) {
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  if (launchUrl === undefined) throw new Error(`runtime did not publish a launch URL: ${output.slice(-2_000)}`)
  const exchanged = await fetch(launchUrl, { redirect: 'manual' })
  if (exchanged.status !== 303) throw new Error(`token exchange returned ${String(exchanged.status)}`)
  const setCookie = exchanged.headers.get('set-cookie')
  const cookie = setCookie?.split(';', 1)[0] ?? ''
  if (!/^dsh-auth-[A-Za-z0-9_-]+=v1\./u.test(cookie)) throw new Error(`token exchange returned an invalid cookie: ${setCookie ?? '<none>'}`)
  const port = Number(new URL(launchUrl).port)
  return {
    port,
    cookie,
    stop: async () => { await stopChild(child) },
  }
}

/** POST one client-request envelope to the runtime `/api` channel. */
async function runtimeRpc(runtime: RuntimeHandle, method: string, args: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const authority = `127.0.0.1:${String(runtime.port)}`
  const response = await fetch(`http://${authority}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: runtime.cookie, host: authority },
    body: JSON.stringify({ type: 'client-request', method, rpcId: crypto.randomUUID(), payload: { args } }),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/** Create one isolated per-user home and workspace, as the Gateway would. */
async function fixtureUser(name: string): Promise<{ home: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), `dsh-multiuser-integration-${name}-`))
  temporaryRoots.push(root)
  const home = join(root, 'dsh-home')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  await prepareUserProfile(join(projectRoot(), 'profiles/user-runtime'), home)
  return { home, workspace }
}

describeIntegration('real dsh runtime', () => {
  let runtime: RuntimeHandle | undefined

  beforeAll(async () => {
    if (dshVersion !== undefined) {
      // The declared version must match the installed one, otherwise CI silently
      // tested a different DSH than compatibility.json claims.
      const { execFileSync } = await import('node:child_process')
      const installed = execFileSync(dshBin!, ['--version'], { encoding: 'utf8' }).trim()
      expect(installed).toBe(dshVersion)
    }
    const user = await fixtureUser('primary')
    runtime = await startRuntime(user.workspace, user.home)
    // Lifecycle is owned by the module-level afterAll, which stops every spawned
    // runtime and only then removes the temporary homes.
  })

  it('serves the authenticated index and rejects anonymous access', async () => {
    const authority = `127.0.0.1:${String(runtime!.port)}`
    const authenticated = await fetch(`http://${authority}/`, { headers: { cookie: runtime!.cookie }, redirect: 'manual' })
    expect(authenticated.status).toBe(200)
    const anonymous = await fetch(`http://${authority}/`, { redirect: 'manual' })
    expect(anonymous.status).toBe(401)
  })

  it('answers session/list with the client-request envelope', async () => {
    const response = await runtimeRpc(runtime!, 'session/list', { _request: {} })
    expect(response.status).toBe(200)
    expect(response.body.type).toBe('server-response')
    expect(response.body.result).toMatchObject({ ok: true, value: { items: [] } })
  })

  it('answers session/search with a request-wrapped query', async () => {
    const response = await runtimeRpc(runtime!, 'session/search', { request: { query: 'compatibility' } })
    expect(response.status).toBe(200)
    expect(response.body.result).toMatchObject({ ok: true, value: { items: [], hasMore: false } })
  })

  it('reports a typed session/not-found error from session/page', async () => {
    const response = await runtimeRpc(runtime!, 'session/page', {
      request: { address: { kind: 'session', sessionId: '00000000-0000-4000-8000-000000000000' }, throughSeq: -1 },
    })
    expect(response.status).toBe(200)
    expect(response.body.result).toMatchObject({ ok: false, error: { code: 'session/not-found' } })
  })

  it('creates a session and pages through its history', async () => {
    const created = await runtimeRpc(runtime!, 'session/create', { request: {} })
    expect(created.body.result).toMatchObject({ ok: true })
    const sessionId = (created.body.result as { value?: { sessionId?: string } }).value?.sessionId
    expect(typeof sessionId).toBe('string')
    const page = await runtimeRpc(runtime!, 'session/page', {
      request: { address: { kind: 'session', sessionId: sessionId! }, throughSeq: -1 },
    })
    expect(page.body.result).toMatchObject({ ok: true })
    const subagents = await runtimeRpc(runtime!, 'subagents/list', { parentSessionId: sessionId! })
    expect(subagents.body.result).toMatchObject({ ok: true })
  })

  it('opens /api/remote.mux with the runtime cookie and rejects anonymous sockets', async () => {
    const authority = `127.0.0.1:${String(runtime!.port)}`
    const authenticated = await new Promise<boolean>((resolvePromise, reject) => {
      const socket = new WebSocket(`ws://${authority}/api/remote.mux`, { headers: { host: authority, cookie: runtime!.cookie } })
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('authenticated remote.mux timed out')) }, 15_000)
      socket.once('open', () => { clearTimeout(timer); socket.close(); resolvePromise(true) })
      socket.once('error', error => { clearTimeout(timer); reject(error) })
    })
    expect(authenticated).toBe(true)
    const anonymous = await new Promise<boolean>(resolvePromise => {
      const socket = new WebSocket(`ws://${authority}/api/remote.mux`, { headers: { host: authority } })
      const timer = setTimeout(() => { socket.terminate(); resolvePromise(false) }, 15_000)
      const denied = () => { clearTimeout(timer); resolvePromise(true) }
      socket.once('error', denied)
      socket.once('close', denied)
      socket.once('open', () => { clearTimeout(timer); socket.terminate(); resolvePromise(false) })
    })
    expect(anonymous).toBe(true)
  })
})

describeIntegration('two-user isolation', () => {
  it('gives each user a separate home, port, and runtime cookie', async () => {
    const alice = await fixtureUser('alice')
    const bob = await fixtureUser('bob')
    const runtimeA = await startRuntime(alice.workspace, alice.home)
    try {
      const runtimeB = await startRuntime(bob.workspace, bob.home)
      try {
        expect(runtimeA.port).not.toBe(runtimeB.port)
        expect(runtimeA.cookie).not.toBe(runtimeB.cookie)
        expect(runtimeA.cookie.split('=')[0]).not.toBe(runtimeB.cookie.split('=')[0])
        // Alice's cookie must not work on Bob's runtime.
        const authorityB = `127.0.0.1:${String(runtimeB.port)}`
        const crossRequest = await fetch(`http://${authorityB}/`, { headers: { cookie: runtimeA.cookie }, redirect: 'manual' })
        expect(crossRequest.status).toBe(401)
        // Each runtime only sees its own (empty) session list.
        const listA = await runtimeRpc(runtimeA, 'session/list', { _request: {} })
        const listB = await runtimeRpc(runtimeB, 'session/list', { _request: {} })
        expect(listA.body.result).toMatchObject({ ok: true, value: { items: [] } })
        expect(listB.body.result).toMatchObject({ ok: true, value: { items: [] } })
      } finally { await runtimeB.stop() }
    } finally { await runtimeA.stop() }
  }, 180_000)
})
