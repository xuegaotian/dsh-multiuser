import { runDshCommand, type DshCommandOptions } from './profile-install.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const REQUIRED_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-multiuser/user-runtime-bundle'])

function normalizeSpec(spec: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?\/?$/u.exec(spec)
  if (match === null) return spec
  const repository = match[2]!.toLowerCase()
  return match[3] === undefined ? `${repository}@latest` : `github:${match[1]}/${match[2]}#${match[3]}`
}

/** Operations the management console needs from the shared DSH Profile. */
export interface PublicProfile {
  list(): Promise<string[]>
  add(spec: string): Promise<void>
  remove(name: string): Promise<void>
  install(): Promise<void>
}

/** Admin-only facade over DSH's native Profile plugin commands. */
export class PublicProfileManager implements PublicProfile {
  private operation: Promise<void> = Promise.resolve()

  constructor(private readonly options: DshCommandOptions, private readonly profile: string) {}
  async list(): Promise<string[]> {
    const value = JSON.parse(await readFile(join(this.options.home, 'profiles', this.profile, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
    return Array.isArray(value.dsh?.profile?.bundles) ? value.dsh.profile.bundles.filter((item): item is string => typeof item === 'string') : []
  }
  async add(spec: string): Promise<void> {
    const normalized = normalizeSpec(spec)
    await this.enqueue(async () => {
      try {
        await runDshCommand(this.options, ['plugin', '--profile', this.profile, 'add', normalized])
      } catch (error) {
        if (!isBuildApprovalFailure(error)) throw error
        await runDshCommand(this.options, ['plugin', '--profile', this.profile, 'approve-builds', '--all'])
        await runDshCommand(this.options, ['plugin', '--profile', this.profile, 'add', normalized])
      }
      await this.verify()
    })
  }
  async remove(name: string): Promise<void> {
    await this.enqueue(async () => {
      if (REQUIRED_BUNDLES.has(name)) throw new Error('required user-runtime Bundle cannot be removed')
      await runDshCommand(this.options, ['plugin', '--profile', this.profile, 'remove', name]); await this.verify()
    })
  }
  async install(): Promise<void> { await this.enqueue(async () => { await runDshCommand(this.options, ['plugin', '--profile', this.profile, 'install']); await this.verify() }) }
  async verify(): Promise<void> { await runDshCommand(this.options, ['--profile', this.profile, '--dump-config']) }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const previous = this.operation
    let release!: () => void
    this.operation = new Promise<void>(resolve => { release = resolve })
    await previous
    try { await operation() } finally { release() }
  }
}

function isBuildApprovalFailure(error: unknown): boolean {
  return error instanceof Error && /IGNORED_BUILDS|approve-builds|Ignored build scripts/iu.test(error.message)
}
