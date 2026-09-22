import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateKeyPair, SignJWT, exportSPKI } from 'jose'
import WebSocket from 'ws'

/**
 * Full-stack integration test: the real Gateway binary driving a real DSH
 * runtime installed from npm. This is the acceptance path from
 * docs/open-source-release/01-dsh-compatibility.md: SSO sign-in, per-user
 * runtime start, HTTP proxying, the `/api` RPC envelope, and the
 * `/api/remote.mux` WebSocket, all through the Gateway.
 *
 * Requires `DSH_INTEGRATION_BIN` (see test/harness-latest.integration.test.ts).
 * The Gateway subprocess is spawned from `src/gateway-cli.ts` with the same
 * arguments a deployment would pass; the DSH command is the npm-published
 * `dsh` binary with no `--launcher-entry` adapter.
 */
const dshBin = process.env.DSH_INTEGRATION_BIN
const dshVersion = process.env.DSH_INTEGRATION_VERSION
const projectRoot = resolve(import.meta.dirname, '..')
const dshBinExists = dshBin !== undefined && existsSync(dshBin)
const describeIntegration = dshBinExists ? describe : describe.skip

interface GatewayHandle {
  base: string
  cookie: string
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return await new Promise(resolve => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

async function startGateway(dataRoot: string): Promise<GatewayHandle> {
  const port = await freePort()
  const base = `http://127.0.0.1:${String(port)}`
  const gateway = spawn('npx', ['tsx', 'src/gateway-cli.ts',
    '--db', join(dataRoot, 'gateway.sqlite'),
    '--data-root', join(dataRoot, 'users'),
    '--dsh-command', dshBin!,
    '--dsh-args', '[]',
    '--profile', 'user-runtime',
    '--profile-source', join(projectRoot, 'profiles/user-runtime'),
    '--host', '127.0.0.1',
    '--port', String(port),
    '--allowed-host', `127.0.0.1:${String(port)}`,
    '--sso-public-key', `sso-2026-01=${join(dataRoot, 'keys/sso-public.pem')}`,
    '--sso-issuer', 'example-idp',
    '--sso-audience', 'dsh-multiuser',
    '--sso-origin', base,
    '--insecure-cookies',
  ], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' } })
  let output = ''
  gateway.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  gateway.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  const start = Date.now()
  while (!output.includes('dsh-multiuser gateway: http') && Date.now() - start < 60_000) {
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  const match = /dsh-multiuser gateway: http:\/\/127\.0\.0\.1:(\d+)/u.exec(output)
  const boundPort = match?.[1]
  if (boundPort === undefined) throw new Error(`gateway did not start: ${output.slice(-2_000)}`)
  if (Number(boundPort) !== port) throw new Error(`gateway bound an unexpected port ${boundPort}`)
  return {
    base,
    cookie: '',
    stop: async () => {
      // Idempotent: `exitCode` is null for a signal-killed process, so both
      // fields are needed to avoid waiting for an `exit` event that already fired.
      if (gateway.exitCode !== null || gateway.signalCode !== null) return
      const exited = new Promise<void>(resolve => { gateway.once('exit', () => resolve()) })
      gateway.kill('SIGTERM')
      await exited
    },
  }
}

describeIntegration('gateway over a real dsh runtime', () => {
  let dataRoot: string
  let gateway: GatewayHandle
  let privateKey: CryptoKey
  let cookie: string

  beforeAll(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'dsh-multiuser-gateway-e2e-'))
    mkdirSync(join(dataRoot, 'users'), { recursive: true })
    mkdirSync(join(dataRoot, 'keys'), { recursive: true })
    const pair = await generateKeyPair('EdDSA')
    privateKey = pair.privateKey
    writeFileSync(join(dataRoot, 'keys/sso-public.pem'), await exportSPKI(pair.publicKey))
    gateway = await startGateway(dataRoot)
  }, 120_000)

  afterAll(async () => {
    // Stop the Gateway (and, through it, the user runtimes it owns) before
    // removing the data root: deleting a tree that a live runtime still writes
    // into makes the removal arbitrarily slow.
    await gateway?.stop()
    await rm(dataRoot, { recursive: true, force: true })
  })

  it('signs in through SSO and starts the user runtime', async () => {
    const now = Math.floor(Date.now() / 1000)
    const jwt = await new SignJWT({
      preferred_username: 'alice',
      name: 'Alice Integration',
      jti: crypto.randomUUID(),
      iat: now, nbf: now, exp: now + 60,
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: 'sso-2026-01' })
      .setIssuer('example-idp')
      .setAudience('dsh-multiuser')
      .setSubject(crypto.randomUUID())
      .sign(privateKey)
    const form = new URLSearchParams({ token: jwt })
    const login = await fetch(`${gateway.base}/auth/sso`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: gateway.base, host: new URL(gateway.base).host },
      body: form.toString(),
      redirect: 'manual',
    })
    expect(login.status).toBe(303)
    expect(login.headers.get('location')).toBe('/')
    const setCookie = login.headers.get('set-cookie') ?? ''
    cookie = setCookie.split(';', 1)[0] ?? ''
    expect(cookie.startsWith('dsh_multiuser_session=')).toBe(true)
  }, 30_000)

  it('proxies the runtime index with the user badge', async () => {
    const index = await fetch(`${gateway.base}/`, { headers: { cookie, host: new URL(gateway.base).host }, redirect: 'manual' })
    expect(index.status).toBe(200)
    const html = await index.text()
    expect(html).toContain('当前用户')
  }, 120_000)

  it('proxies the /api RPC channel', async () => {
    const rpc = await fetch(`${gateway.base}/api/session/list`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', host: new URL(gateway.base).host },
      body: JSON.stringify({ type: 'client-request', method: 'session/list', rpcId: crypto.randomUUID(), payload: { args: { _request: {} } } }),
    })
    expect(rpc.status).toBe(200)
    expect(await rpc.json()).toMatchObject({ result: { ok: true, value: { items: [] } } })
  }, 30_000)

  it('proxies the /api/remote.mux WebSocket', async () => {
    const authority = new URL(gateway.base).host
    const opened = await new Promise<boolean>((resolvePromise, reject) => {
      const socket = new WebSocket(`ws://${authority}/api/remote.mux`, { headers: { host: authority, cookie } })
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('remote.mux through the gateway timed out')) }, 30_000)
      socket.once('open', () => { clearTimeout(timer); socket.close(); resolvePromise(true) })
      socket.once('error', error => { clearTimeout(timer); reject(error) })
    })
    expect(opened).toBe(true)
  }, 60_000)
})
