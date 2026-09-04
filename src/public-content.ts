import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

function skillName(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) throw new Error('skill name must be kebab-case')
  return value
}

function filePath(value: string): string {
  if (value === 'SKILL.md') return value
  if (value === '' || value.startsWith('/') || value.includes('\\')) throw new Error('skill file path is invalid')
  const segments = value.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) throw new Error('skill file path is invalid')
  return value
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) paths.push(...await listFiles(join(root, entry.name), relative))
    else if (entry.isFile()) paths.push(relative)
  }
  return paths.sort()
}

export interface PublicSkillFile {
  path: string
  content: string
}

export interface PublicSkill {
  name: string
  content: string
  files: string[]
}

/** Deployment-owned shared Skill directory consumed through DSH_AGENTS_HOME. */
export class PublicSkillStore {
  constructor(private readonly root: string) {}

  async list(): Promise<PublicSkill[]> {
    try {
      const entries = await readdir(join(this.root, 'skills'), { withFileTypes: true })
      return Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
        const directory = join(this.root, 'skills', entry.name)
        return { name: entry.name, content: await readFile(join(directory, 'SKILL.md'), 'utf8'), files: await listFiles(directory) }
      }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async save(name: string, content: string): Promise<void> {
    const safeName = skillName(name)
    if (content.trim() === '') throw new Error('skill content is required')
    const target = join(this.root, 'skills', safeName)
    await mkdir(target, { recursive: true, mode: 0o700 })
    await writeFile(join(target, 'SKILL.md'), content)
  }

  /** Replace a shared Skill directory with browser-uploaded files. */
  async import(name: string, files: readonly PublicSkillFile[]): Promise<void> {
    const safeName = skillName(name)
    if (files.length === 0 || files.length > 512) throw new Error('Skill must contain between 1 and 512 files')
    const paths = new Set<string>()
    const targetRoot = join(this.root, 'skills')
    await mkdir(targetRoot, { recursive: true, mode: 0o700 })
    const temporary = await mkdtemp(join(targetRoot, '.upload-'))
    try {
      for (const file of files) {
        const path = filePath(file.path)
        if (paths.has(path)) throw new Error('Skill contains duplicate file paths')
        paths.add(path)
        if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(file.content)) throw new Error('Skill file content must be base64')
        const content = Buffer.from(file.content, 'base64')
        if (content.byteLength > 16 * 1024 * 1024) throw new Error('Skill file exceeds 16 MiB')
        const target = join(temporary, path)
        await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 })
        await writeFile(target, content, { mode: /^scripts\/.+\.(?:sh|bash|py|js|mjs|cjs|command)$/u.test(path) ? 0o700 : 0o600 })
      }
      if (!paths.has('SKILL.md')) throw new Error('Skill package must contain SKILL.md at its root')
      if ((await readFile(join(temporary, 'SKILL.md'), 'utf8')).trim() === '') throw new Error('skill content is required')
      const target = join(targetRoot, safeName)
      const backup = join(targetRoot, `.${safeName}.previous`)
      await rm(backup, { recursive: true, force: true })
      try { await rename(target, backup) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      try { await rename(temporary, target) } catch (error) {
        try { await rename(backup, target) } catch { /* The original replacement error remains actionable. */ }
        throw error
      }
      await rm(backup, { recursive: true, force: true })
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  }

  async remove(name: string): Promise<void> {
    await rm(join(this.root, 'skills', skillName(name)), { recursive: true, force: true })
  }

  path(): string { return resolve(this.root, 'skills') }
}
