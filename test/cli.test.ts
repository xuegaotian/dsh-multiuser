import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '..')

function runCli(args: string[], options: { cwd?: string } = {}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', resolve(projectRoot, 'src/cli.ts'), ...args], {
      cwd: options.cwd ?? projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', code => resolvePromise({ code, output }))
  })
}

describe('CLI preview safety', () => {
  it('lists upgrade as disabled in preview releases', async () => {
    const result = await runCli(['--help'])
    expect(result.code).toBe(0)
    expect(result.output).toContain('upgrade')
    expect(result.output).toContain('disabled in preview releases')
  })

  it('rejects upgrade without changing application or data', async () => {
    const result = await runCli(['upgrade'])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('upgrade is disabled in preview releases')
    expect(result.output).toContain('stop the service -> backup -> install')
  })

  it('creates the database parent directory on demand', async () => {
    // A fresh clone has no data/ directory. SQLite cannot create a file inside a
    // missing directory, so init-admin must create the parent itself; otherwise
    // the documented quick start fails on its very first command.
    const root = await mkdtemp(join(tmpdir(), 'dsh-multiuser-cli-mkdir-'))
    try {
      const db = join(root, 'nested', 'deeper', 'gateway.sqlite')
      const child = spawn(
        process.execPath,
        ['--import', 'tsx/esm', resolve(projectRoot, 'src/cli.ts'),
          'init-admin', '--db', db, '--username', 'admin', '--display-name', 'Admin', '--password-stdin'],
        // Keep cwd at the project root so the tsx loader resolves; the database
        // path itself is absolute, which is what triggers the mkdir behavior.
        { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      child.stdin.end('TestPassword123!\n')
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      const code = await new Promise<number | null>(resolvePromise => { child.once('close', resolvePromise) })

      expect(output).not.toContain('unable to open database file')
      expect(code).toBe(0)
      await expect(stat(join(root, 'nested', 'deeper', 'gateway.sqlite'))).resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('describes start as print-only rather than a daemon', async () => {
    const result = await runCli(['start', '--help'])
    expect(result.code).toBe(0)
    expect(result.output).toContain('does not daemonize')
  })
})
