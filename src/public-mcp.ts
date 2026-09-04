import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const PUBLIC_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,24}$/u
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'
const PUBLIC_ID_PREFIX = 'dsh-multiuser-public-mcp-'
const PUBLIC_SERVER_PREFIX = 'public_'

interface PublicMcpBase {
  name: string
  enabled: boolean
  toolCallTimeoutMs: number
  failOnStartupError: boolean
}

export interface PublicStdioMcp extends PublicMcpBase {
  transport: 'stdio'
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface PublicHttpMcp extends PublicMcpBase {
  transport: 'streamable-http'
  url: string
  headers: Record<string, string>
}

export type PublicMcpServer = PublicStdioMcp | PublicHttpMcp

export type PublicMcpDescription = Omit<PublicStdioMcp, 'env'> & { serverName: string; envKeys: string[] }
  | Omit<PublicHttpMcp, 'headers'> & { serverName: string; headerNames: string[] }

interface McpPatchRow {
  id: string
  name: typeof MCP_CLIENT_PACKAGE
  disabled: boolean
  config: Record<string, unknown>
}

interface McpPatch {
  insert: McpPatchRow[]
}

/** Persist and project deployment-owned MCP servers as one DSH patch overlay. */
export class PublicMcpStore {
  private operation: Promise<void> = Promise.resolve()
  readonly overlayPath: string

  constructor(path: string) { this.overlayPath = resolve(path) }

  /** Ensure an empty overlay exists before any user Runtime starts. */
  async initialize(): Promise<void> {
    try {
      await readFile(this.overlayPath, 'utf8')
      await this.read()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.write([])
    }
  }

  /** List public MCP configuration without returning header or environment values. */
  async list(): Promise<PublicMcpDescription[]> {
    return (await this.read()).map(describeServer)
  }

  /** Regenerate the current public overlay in one user Runtime's deployment-owned area. */
  async installForRuntime(path: string): Promise<void> {
    await writeOverlay(resolve(path), await this.read())
  }

  /** Create or replace one public MCP server, preserving blank secret values by key. */
  async save(input: unknown): Promise<PublicMcpDescription[]> {
    await this.enqueue(async () => {
      const servers = await this.read()
      const candidate = validateInput(input, servers.find(server => server.name === inputName(input)))
      const index = servers.findIndex(server => server.name === candidate.name)
      if (index < 0) servers.push(candidate)
      else servers[index] = candidate
      servers.sort((left, right) => left.name.localeCompare(right.name))
      await this.write(servers)
    })
    return this.list()
  }

  /** Remove one public MCP server by its deployment-owned name. */
  async remove(name: string): Promise<PublicMcpDescription[]> {
    validateName(name)
    await this.enqueue(async () => {
      const servers = await this.read()
      const remaining = servers.filter(server => server.name !== name)
      if (remaining.length === servers.length) throw new Error(`public MCP server not found: ${name}`)
      await this.write(remaining)
    })
    return this.list()
  }

  private async read(): Promise<PublicMcpServer[]> {
    let content: string
    try { content = await readFile(this.overlayPath, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const parsed: unknown = JSON.parse(content)
    if (!Array.isArray(parsed) || parsed.length > 1) throw new Error('public MCP overlay must contain zero or one insert patch')
    if (parsed.length === 0) return []
    const patch = parsed[0]
    if (typeof patch !== 'object' || patch === null || !Array.isArray((patch as { insert?: unknown }).insert)) throw new Error('public MCP overlay insert patch is invalid')
    const servers = (patch as McpPatch).insert.map(row => serverFromRow(row))
    if (new Set(servers.map(server => server.name)).size !== servers.length) throw new Error('public MCP overlay contains duplicate names')
    return servers
  }

  private async write(servers: PublicMcpServer[]): Promise<void> {
    await writeOverlay(this.overlayPath, servers)
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const previous = this.operation
    let release!: () => void
    this.operation = new Promise<void>(resolve => { release = resolve })
    await previous
    try { await operation() } finally { release() }
  }
}

function describeServer(server: PublicMcpServer): PublicMcpDescription {
  if (server.transport === 'stdio') {
    const { env, ...description } = server
    return { ...description, serverName: publicServerName(server.name), envKeys: Object.keys(env).sort() }
  }
  const { headers, ...description } = server
  return { ...description, serverName: publicServerName(server.name), headerNames: Object.keys(headers).sort() }
}

async function writeOverlay(path: string, servers: PublicMcpServer[]): Promise<void> {
  const patches: McpPatch[] = servers.length === 0 ? [] : [{ insert: servers.map(serverToRow) }]
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(`${JSON.stringify(patches, undefined, 2)}\n`)
      await file.chmod(0o600)
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } catch (error) {
    try { await unlink(temporary) } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError
    }
    throw error
  }
}

function inputName(input: unknown): string | undefined {
  return typeof input === 'object' && input !== null && typeof (input as { name?: unknown }).name === 'string'
    ? (input as { name: string }).name
    : undefined
}

function validateInput(input: unknown, existing?: PublicMcpServer): PublicMcpServer {
  if (typeof input !== 'object' || input === null) throw new Error('public MCP configuration must be an object')
  const value = input as Record<string, unknown>
  if (typeof value.name !== 'string') throw new Error('public MCP name is required')
  const name = value.name.trim()
  validateName(name)
  const enabled = value.enabled === undefined ? true : requireBoolean(value.enabled, 'enabled')
  const toolCallTimeoutMs = value.toolCallTimeoutMs === undefined ? 60_000 : requireInteger(value.toolCallTimeoutMs, 'toolCallTimeoutMs', 1, 3_600_000)
  const failOnStartupError = value.failOnStartupError === undefined ? false : requireBoolean(value.failOnStartupError, 'failOnStartupError')
  if (value.transport === 'stdio') {
    const command = requireText(value.command, 'command')
    const args = requireStringArray(value.args ?? [], 'args')
    const cwd = value.cwd === undefined ? '' : requireSafeString(value.cwd, 'cwd')
    const prior = existing?.transport === 'stdio' ? existing.env : {}
    const env = requireStringRecord(value.env ?? {}, 'env', ENV_NAME_PATTERN, prior)
    return { name, enabled, transport: 'stdio', command, args, cwd, env, toolCallTimeoutMs, failOnStartupError }
  }
  if (value.transport === 'streamable-http') {
    const url = requireText(value.url, 'url')
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error('MCP URL must use http or https')
    if (parsedUrl.username !== '' || parsedUrl.password !== '') throw new Error('MCP URL must not contain credentials; use request headers')
    const prior = existing?.transport === 'streamable-http' ? existing.headers : {}
    const headers = requireStringRecord(value.headers ?? {}, 'headers', HEADER_NAME_PATTERN, prior, true)
    return { name, enabled, transport: 'streamable-http', url: parsedUrl.toString(), headers, toolCallTimeoutMs, failOnStartupError }
  }
  throw new Error('transport must be stdio or streamable-http')
}

function serverToRow(server: PublicMcpServer): McpPatchRow {
  const base = {
    serverName: publicServerName(server.name), transport: server.transport,
    toolCallTimeoutMs: server.toolCallTimeoutMs, failOnStartupError: server.failOnStartupError,
  }
  return {
    id: `${PUBLIC_ID_PREFIX}${server.name}`,
    name: MCP_CLIENT_PACKAGE,
    disabled: !server.enabled,
    config: server.transport === 'stdio'
      ? { ...base, command: server.command, args: server.args, cwd: server.cwd, env: server.env }
      : { ...base, url: server.url, headers: server.headers },
  }
}

function serverFromRow(row: McpPatchRow): PublicMcpServer {
  if (typeof row !== 'object' || row === null || row.name !== MCP_CLIENT_PACKAGE || typeof row.id !== 'string' || !row.id.startsWith(PUBLIC_ID_PREFIX) || typeof row.disabled !== 'boolean' || typeof row.config !== 'object' || row.config === null) {
    throw new Error('public MCP overlay row is invalid')
  }
  const name = row.id.slice(PUBLIC_ID_PREFIX.length)
  const config = row.config
  return validateInput({ ...config, name, enabled: !row.disabled })
}

function publicServerName(name: string): string { return `${PUBLIC_SERVER_PREFIX}${name}` }

function validateName(name: string): void {
  if (!PUBLIC_NAME_PATTERN.test(name)) throw new Error('public MCP name must be 1-25 lowercase letters, digits, underscores, or hyphens')
}

function requireText(value: unknown, label: string): string {
  const text = requireSafeString(value, label).trim()
  if (text === '') throw new Error(`${label} is required`)
  return text
}

function requireSafeString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`${label} must be a string without NUL bytes`)
  return value
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer between ${String(minimum)} and ${String(maximum)}`)
  return value
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && !item.includes('\0'))) throw new Error(`${label} must be an array of strings without NUL bytes`)
  return [...value]
}

function requireStringRecord(value: unknown, label: string, namePattern: RegExp, prior: Record<string, string>, rejectLineBreaks = false): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be a string dictionary`)
  const result: Record<string, string> = {}
  for (const [name, item] of Object.entries(value)) {
    if (!namePattern.test(name)) throw new Error(`${label} contains an invalid name: ${name}`)
    if (typeof item !== 'string' || item.includes('\0') || (rejectLineBreaks && /[\r\n]/u.test(item))) throw new Error(`${label}.${name} contains an invalid value`)
    result[name] = item === '' && prior[name] !== undefined ? prior[name] : item
  }
  return result
}
