import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PublicMcpStore } from '../src/public-mcp.js'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function fixture(): Promise<{ path: string; store: PublicMcpStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-multiuser-public-mcp-'))
  directories.push(directory)
  const path = join(directory, 'public-mcp.cordis.yml')
  const store = new PublicMcpStore(path)
  await store.initialize()
  return { path, store }
}

describe('PublicMcpStore', () => {
  it('projects an HTTP server into a reserved public namespace without returning headers', async () => {
    const { path, store } = await fixture()
    await store.save({
      name: 'ops', transport: 'streamable-http', url: 'https://mcp.example.test/mcp',
      headers: { Authorization: 'Bearer shared-secret' }, enabled: true,
    })

    expect(await store.list()).toEqual([expect.objectContaining({
      name: 'ops', serverName: 'public_ops', transport: 'streamable-http',
      url: 'https://mcp.example.test/mcp', headerNames: ['Authorization'], enabled: true,
    })])
    expect(JSON.stringify(await store.list())).not.toContain('shared-secret')
    const patch = JSON.parse(await readFile(path, 'utf8')) as Array<{ insert: Array<Record<string, unknown>> }>
    expect(patch[0]?.insert[0]).toMatchObject({
      id: 'dsh-multiuser-public-mcp-ops', name: '@deepseek-ai/dsh-mcp-client', disabled: false,
      config: { serverName: 'public_ops', transport: 'streamable-http', headers: { Authorization: 'Bearer shared-secret' } },
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('preserves blank secret values during edits and removes the whole public row', async () => {
    const { path, store } = await fixture()
    await store.save({ name: 'memory', transport: 'stdio', command: 'memory-mcp', args: ['serve'], cwd: '', env: { API_TOKEN: 'secret' } })
    await store.save({ name: 'memory', transport: 'stdio', command: 'memory-mcp', args: ['serve', '--quiet'], cwd: '', env: { API_TOKEN: '' }, enabled: false })

    expect(await store.list()).toEqual([expect.objectContaining({ name: 'memory', serverName: 'public_memory', envKeys: ['API_TOKEN'], enabled: false, args: ['serve', '--quiet'] })])
    expect(await readFile(path, 'utf8')).toContain('secret')
    await store.remove('memory')
    expect(await store.list()).toEqual([])
  })

  it('keeps existing public MCP configuration when the store initializes again', async () => {
    const { path, store } = await fixture()
    await store.save({ name: 'ops', transport: 'streamable-http', url: 'https://mcp.example.test/mcp', headers: {} })

    const restarted = new PublicMcpStore(path)
    await restarted.initialize()

    expect(await restarted.list()).toEqual([expect.objectContaining({ name: 'ops', serverName: 'public_ops' })])
  })

  it('installs an isolated snapshot for one user Runtime', async () => {
    const { path, store } = await fixture()
    await store.save({ name: 'ops', transport: 'streamable-http', url: 'https://mcp.example.test/mcp', headers: {} })
    const tampered = JSON.parse(await readFile(path, 'utf8')) as Array<{ insert: Array<{ config: { serverName: string } }> }>
    tampered[0]!.insert[0]!.config.serverName = 'private_collision'
    await writeFile(path, JSON.stringify(tampered))
    const target = join(directories.at(-1)!, 'users', 'alice', 'dsh-home', '.dsh-multiuser', 'public-mcp.cordis.yml')

    await store.installForRuntime(target)

    expect(await readFile(target, 'utf8')).toContain('public_ops')
    expect(await readFile(target, 'utf8')).not.toContain('private_collision')
    expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('rejects a corrupt public overlay during Gateway initialization', async () => {
    const { path } = await fixture()
    await writeFile(path, '{not-json')
    await expect(new PublicMcpStore(path).initialize()).rejects.toThrow()
  })

  it('rejects names outside the public namespace budget and invalid HTTP headers', async () => {
    const { store } = await fixture()
    await expect(store.save({ name: 'UserOwned', transport: 'stdio', command: 'mcp' })).rejects.toThrow('public MCP name')
    await expect(store.save({ name: 'ops', transport: 'streamable-http', url: 'file:///tmp/mcp', headers: {} })).rejects.toThrow('http or https')
    await expect(store.save({ name: 'ops', transport: 'streamable-http', url: 'https://user:secret@example.test/mcp', headers: {} })).rejects.toThrow('must not contain credentials')
    await expect(store.save({ name: 'ops', transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'bad\nvalue' } })).rejects.toThrow('invalid value')
  })
})
