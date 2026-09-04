import { describe, expect, it } from 'vitest'
import { runDshCommand } from '../src/profile-install.js'

describe('profile command execution', () => {
  it('returns child diagnostics when the command fails', async () => {
    await expect(runDshCommand({ command: process.execPath, args: ['-e', "process.stderr.write('diagnostic\n'); process.exit(3)"], home: '/tmp/dsh-test-home' }, [])).rejects.toThrow('diagnostic')
  })

  it('rejects a command that exceeds its deadline', async () => {
    await expect(runDshCommand({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10_000)'], home: '/tmp/dsh-test-home', timeoutMs: 20 }, [])).rejects.toThrow('timed out after 20ms')
  })
})
