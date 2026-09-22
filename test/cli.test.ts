import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '..')

function runCli(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', resolve(projectRoot, 'src/cli.ts'), ...args], {
      cwd: projectRoot,
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
})
