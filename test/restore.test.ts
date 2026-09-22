import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthStore } from '../src/auth-local.js'
import { runBackup } from '../src/backup.js'
import { runRestore } from '../src/restore.js'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-restore-'))
  dirs.push(dir)
  return dir
}

function captureStdout(): { read: () => string; restore: () => void } {
  const buf: string[] = []
  const original = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    buf.push(chunk.toString())
    return true
  }) as unknown as typeof process.stdout.write
  return { read: () => buf.join(''), restore: () => { process.stdout.write = original } }
}

function userCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath)
  try {
    return (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n
  } finally {
    db.close()
  }
}

interface Seed {
  root: string
  dataDir: string
  /** The data root exactly as `--data-root` is documented: `<data-dir>/users`. */
  dataRoot: string
  /** The credential store, documented as `<data-dir>/gateway.sqlite` — a SIBLING of the data root. */
  dbPath: string
  from: string
}

/**
 * Build a data root in the canonical production layout and back it up.
 *
 * The layout matters as much as the code under test: `--data-root` is the
 * `users/` level, and per-user directories plus `profile-template/`,
 * `public-agents/` and `public-mcp.cordis.yml` all sit DIRECTLY inside it
 * (`gateway.ts` profileTemplateCheck, `runtime-manager.ts` userRoot). Fixtures
 * that nest these one level deeper would hide a level-offset bug.
 */
async function seedBackup(): Promise<Seed> {
  const root = await tmp()
  const dataDir = join(root, 'data')
  const dataRoot = join(dataDir, 'users')
  const dbPath = join(dataDir, 'gateway.sqlite')

  await mkdir(join(dataRoot, 'u-alice'), { recursive: true })
  await writeFile(join(dataRoot, 'u-alice', 'state.json'), '{"id":"u-alice"}')
  await mkdir(join(dataRoot, 'profile-template', 'profiles', 'user-runtime'), { recursive: true })
  await writeFile(join(dataRoot, 'profile-template', 'profiles', 'user-runtime', 'package.json'), '{"name":"user-runtime"}')
  await mkdir(join(dataRoot, 'public-agents', 'demo'), { recursive: true })
  await writeFile(join(dataRoot, 'public-agents', 'demo', 'SKILL.md'), 'demo')
  await writeFile(join(dataRoot, 'public-mcp.cordis.yml'), 'mcp: {}')

  const auth = new AuthStore(dbPath)
  try {
    await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a sufficiently long password', role: 'user' })
  } finally {
    auth.close()
  }

  const backup = await runBackup({ db: dbPath, dataRoot, to: join(root, 'backups') })
  return { root, dataDir, dataRoot, dbPath, from: backup.directory }
}

describe('runRestore', () => {
  it('restores a destroyed data root at the canonical level, keeping the gateway-resolved paths', async () => {
    const seed = await seedBackup()

    // Lose everything: the data root and the credential store.
    await rm(seed.dataRoot, { recursive: true, force: true })
    await rm(seed.dbPath, { force: true })

    const result = await runRestore({ from: seed.from, dataRoot: seed.dataRoot, db: seed.dbPath })

    expect(result.database).toBe(seed.dbPath)
    expect(result.users).toBe(seed.dataRoot)
    expect(userCount(seed.dbPath)).toBe(1)

    // Assert the exact paths the gateway resolves at runtime, not just "a dir exists".
    expect(existsSync(join(seed.dataRoot, 'profile-template', 'profiles', 'user-runtime', 'package.json'))).toBe(true)
    expect(existsSync(join(seed.dataRoot, 'public-agents', 'demo', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(seed.dataRoot, 'public-mcp.cordis.yml'))).toBe(true)
    expect(existsSync(join(seed.dataRoot, 'u-alice', 'state.json'))).toBe(true)

    // Regression: the restored contents must NOT be nested one level deeper.
    // Writing them to <dataRoot>/users/... leaves every user invisible to the
    // gateway and makes /readyz fail PROFILE_TEMPLATE_MISSING.
    expect(existsSync(join(seed.dataRoot, 'users'))).toBe(false)
  })

  it('rejects a tampered snapshot and leaves the target untouched', async () => {
    const seed = await seedBackup()

    // Flip one byte of the snapshot.
    const snapshot = join(seed.from, 'database.sqlite')
    const buffer = await readFile(snapshot)
    const tampered = Buffer.from(buffer)
    tampered.writeUInt8(tampered.readUInt8(0) ^ 0xff, 0)
    await writeFile(snapshot, tampered)

    const targetDir = join(seed.root, 'target')
    await expect(runRestore({ from: seed.from, dataRoot: targetDir })).rejects.toThrow(/sha256 mismatch/iu)
    // Target was never created.
    expect(existsSync(targetDir)).toBe(false)
  })

  it('refuses a non-empty data root without --force, and moves it aside with it', async () => {
    const seed = await seedBackup()

    const targetRoot = join(seed.root, 'target-users')
    await mkdir(join(targetRoot, 'stale'), { recursive: true })
    await writeFile(join(targetRoot, 'stale', 'x'), 'OLD-DATA')
    const targetDb = join(seed.root, 'target-gateway.sqlite')

    await expect(runRestore({ from: seed.from, dataRoot: targetRoot, db: targetDb })).rejects.toThrow(/not empty/iu)

    const result = await runRestore({ from: seed.from, dataRoot: targetRoot, db: targetDb, force: true })
    const [movedRoot] = result.safetyCopies
    expect(result.safetyCopies).toHaveLength(1)
    expect(movedRoot?.startsWith(`${targetRoot}.pre-restore-`)).toBe(true)
    expect(await readFile(join(movedRoot as string, 'stale', 'x'), 'utf8')).toBe('OLD-DATA')
    // Restored content is the backup, not the stale data.
    expect(userCount(targetDb)).toBe(1)
    expect(existsSync(join(targetRoot, 'stale'))).toBe(false)
  })

  it('moves an existing database aside even when the data root does not exist', async () => {
    // The documented layout puts the database OUTSIDE the data root, so moving
    // only the data root would silently clobber the previous database in place.
    const seed = await seedBackup()

    const targetRoot = join(seed.root, 'fresh-users')
    const targetDb = join(seed.root, 'existing-gateway.sqlite')
    await writeFile(targetDb, 'OLD-DATABASE')

    await expect(runRestore({ from: seed.from, dataRoot: targetRoot, db: targetDb })).rejects.toThrow(/already exists/iu)

    const result = await runRestore({ from: seed.from, dataRoot: targetRoot, db: targetDb, force: true })
    const [movedDb] = result.safetyCopies
    expect(result.safetyCopies).toHaveLength(1)
    expect(movedDb?.startsWith(`${targetDb}.pre-restore-`)).toBe(true)
    expect(await readFile(movedDb as string, 'utf8')).toBe('OLD-DATABASE')
    expect(userCount(targetDb)).toBe(1)
  })

  it('warns when the target data root itself contains a users/ directory', async () => {
    // The most likely operator mistake: passing <data-dir> instead of
    // <data-dir>/users. The restore still works, but the operator must be told.
    const seed = await seedBackup()

    const targetRoot = join(seed.root, 'passed-the-parent')
    await mkdir(join(targetRoot, 'users', 'stale'), { recursive: true })

    const result = await runRestore({ from: seed.from, dataRoot: targetRoot, db: join(seed.root, 'warn.sqlite'), force: true })
    expect(result.warnings.some(warning => warning.includes('contains a "users" directory'))).toBe(true)
  })

  it('rejects restoring the database into the backup directory', async () => {
    const seed = await seedBackup()
    const badDb = join(seed.from, 'inner.sqlite')
    await expect(runRestore({ from: seed.from, dataRoot: seed.dataRoot, db: badDb })).rejects.toThrow(/inside the backup directory/iu)
  })

  it('carries the shared model configuration that lives beside the database', async () => {
    // The gateway defaults --gateway-env to dirname(--db)/gateway.env, which is
    // outside BOTH the data root and the systemd --config-dir. Losing it would
    // bring the gateway back with no model credentials.
    const seed = await seedBackup()
    await writeFile(join(seed.dataDir, 'gateway.env'), 'DEEPSEEK_API_KEY=sk-shared-secret\nDSH_PUBLIC_LLM_PROVIDERS={}\n')

    const backup = await runBackup({ db: seed.dbPath, dataRoot: seed.dataRoot, to: join(seed.root, 'backups2') })
    expect(backup.manifest.entries.map(entry => entry.name)).toContain('gateway.env')

    await rm(seed.dataRoot, { recursive: true, force: true })
    await rm(seed.dbPath, { force: true })
    await rm(join(seed.dataDir, 'gateway.env'), { force: true })

    const capture = captureStdout()
    let result
    try {
      result = await runRestore({ from: backup.directory, dataRoot: seed.dataRoot, db: seed.dbPath })
    } finally {
      capture.restore()
    }
    const restored = join(seed.dataDir, 'gateway.env')
    expect(result.globalConfig).toBe(restored)
    expect(await readFile(restored, 'utf8')).toContain('sk-shared-secret')
    expect((await stat(restored)).mode & 0o777).toBe(0o600)
    // Never echo the credential itself.
    expect(capture.read()).not.toContain('sk-shared-secret')
  })

  it('moves an existing model configuration aside instead of overwriting it', async () => {
    const seed = await seedBackup()
    await writeFile(join(seed.dataDir, 'gateway.env'), 'DEEPSEEK_API_KEY=sk-new\n')

    const backup = await runBackup({ db: seed.dbPath, dataRoot: seed.dataRoot, to: join(seed.root, 'backups2') })
    await writeFile(join(seed.dataDir, 'gateway.env'), 'DEEPSEEK_API_KEY=sk-old\n')
    // Isolate the model-config branch: with the data root gone, the ONLY
    // pre-existing target data is the model configuration.
    await rm(seed.dataRoot, { recursive: true, force: true })
    await rm(seed.dbPath, { force: true })

    await expect(runRestore({ from: backup.directory, dataRoot: seed.dataRoot, db: seed.dbPath })).rejects.toThrow(/already exists/iu)

    const result = await runRestore({ from: backup.directory, dataRoot: seed.dataRoot, db: seed.dbPath, force: true })
    const movedConfig = result.safetyCopies.find(copy => copy.includes('gateway.env'))
    expect(movedConfig).toBeDefined()
    expect(await readFile(movedConfig as string, 'utf8')).toContain('sk-old')
    expect(await readFile(join(seed.dataDir, 'gateway.env'), 'utf8')).toContain('sk-new')
  })

  it('performs no writes under --dry-run', async () => {
    const seed = await seedBackup()

    const targetRoot = join(seed.root, 'target')
    const capture = captureStdout()
    let result
    try {
      result = await runRestore({ from: seed.from, dataRoot: targetRoot, dryRun: true })
    } finally {
      capture.restore()
    }
    expect(existsSync(targetRoot)).toBe(false)
    expect(existsSync(join(targetRoot, 'gateway.sqlite'))).toBe(false)
    expect(capture.read()).toContain('dry run')
    expect(result.database).toBe(join(targetRoot, 'gateway.sqlite'))
  })

  it('restores config with 0700 permissions without leaking secret values', async () => {
    const seed = await seedBackup()
    const configDir = join(seed.root, 'etc', 'dsh-multiuser')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'gateway.env'), 'DEEPSEEK_API_KEY=super-secret-value\n')

    const backup = await runBackup({ db: seed.dbPath, dataRoot: seed.dataRoot, to: join(seed.root, 'backups2'), configDir })
    const targetRoot = join(seed.root, 'target')
    const targetConfig = join(seed.root, 'target-etc')
    const capture = captureStdout()
    let result
    try {
      result = await runRestore({ from: backup.directory, dataRoot: targetRoot, configDir: targetConfig })
    } finally {
      capture.restore()
    }
    expect(result.config).toBe(targetConfig)
    expect(existsSync(targetConfig)).toBe(true)
    expect((await stat(targetConfig)).mode & 0o777).toBe(0o700)
    // Content is preserved on disk...
    expect(await readFile(join(targetConfig, 'gateway.env'), 'utf8')).toContain('super-secret-value')
    // ...but the summary never prints the secret value.
    expect(capture.read()).not.toContain('super-secret-value')
  })
})
