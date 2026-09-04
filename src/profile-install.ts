import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { prepareUserProfile } from './user-profile.js'

export interface DshCommandOptions {
  command: string
  args: readonly string[]
  home: string
  cwd?: string
  timeoutMs?: number
}

/** Run a DSH CLI command with an explicit Harness home. */
export function runDshCommand(options: DshCommandOptions, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timeoutMs = options.timeoutMs ?? 120_000
    let output = ''
    let settled = false
    const child = spawn(options.command, [...options.args, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, DSH_HOME: options.home },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    const append = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf8')}`.slice(-12_000)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => { if (!settled) child.kill('SIGKILL') }, 2_000).unref()
      finish(() => reject(new Error(`DSH command timed out after ${String(timeoutMs)}ms${formatOutput(output)}`)))
    }, timeoutMs)
    child.once('error', error => finish(() => reject(error)))
    child.once('close', (code, signal) => {
      if (code === 0) finish(resolvePromise)
      else finish(() => reject(new Error(`DSH command failed (${signal ?? `exit ${String(code)}`})${formatOutput(output)}`)))
    })
  })
}

function formatOutput(output: string): string {
  const cleaned = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/\r/gu, '').trim()
  return cleaned === '' ? '' : `: ${cleaned}`
}

/** Install the multi-user Bundle through DSH and verify the resulting composition. */
export async function installUserRuntimeProfile(
  options: DshCommandOptions,
  profile: string,
  profileSource: string,
): Promise<void> {
  await mkdir(options.home, { recursive: true })
  await prepareUserProfile(profileSource, options.home)
  await runDshCommand(options, ['plugin', '--profile', profile, 'install'])
  await runDshCommand(options, ['--profile', profile, '--dump-config'])
}
