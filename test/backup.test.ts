import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthStore } from '../src/auth-local.js'
import { runBackup } from '../src/backup.js'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-backup-'))
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

function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  return new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk as Buffer))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function makeStore(dbPath: string): AuthStore {
  return new AuthStore(dbPath)
}

describe('runBackup', () => {
  it('backs up a database and copies the users tree with a complete manifest', async () => {
    const root = await tmp()
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { recursive: true })
    const dbPath = join(dataDir, 'gateway.sqlite')
    const auth = makeStore(dbPath)
    try {
      await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a sufficiently long password', role: 'user' })

      const capture = captureStdout()
      let result
      try {
        result = await runBackup({ db: dbPath, dataRoot: dataDir, to: join(root, 'backups') })
      } finally {
        capture.restore()
      }

      expect(result.directory).toBeTruthy()
      const dbFile = join(result.directory, 'database.sqlite')
      expect(existsSync(dbFile)).toBe(true)

      const snap = new DatabaseSync(dbFile)
      try {
        const count = (snap.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n
        expect(count).toBe(1)
      } finally {
        snap.close()
      }

      expect(existsSync(join(result.directory, 'users'))).toBe(true)

      const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
        app: { name: string; version: string }
        node: string
        dsh: { tested: string[]; canary: string[] }
        database: { source: string; snapshot: string; sha256: string; bytes: number }
        entries: Array<{ kind: string; name: string; bytes: number; files: number }>
        warnings: string[]
      }
      expect(manifest.app.name).toBeTruthy()
      expect(manifest.app.version).toBeTruthy()
      expect(manifest.node).toBeTruthy()
      expect(Array.isArray(manifest.dsh.tested)).toBe(true)
      expect(Array.isArray(manifest.dsh.canary)).toBe(true)
      expect(manifest.database.source).toBe(dbPath)
      expect(manifest.database.snapshot).toBe(dbFile)
      expect(manifest.database.bytes).toBeGreaterThan(0)
      expect(manifest.database.sha256).toBe(await sha256Of(dbFile))
      expect(manifest.entries.find(entry => entry.name === 'database.sqlite')).toBeTruthy()
      expect(manifest.entries.find(entry => entry.name === 'users')).toBeTruthy()
      expect(Array.isArray(manifest.warnings)).toBe(true)
    } finally {
      auth.close()
    }
  })

  it('produces a valid snapshot while the gateway database is held open', async () => {
    const root = await tmp()
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { recursive: true })
    const dbPath = join(dataDir, 'gateway.sqlite')
    const auth = makeStore(dbPath)
    try {
      await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a sufficiently long password', role: 'user' })

      // The AuthStore connection stays open through the backup (running gateway).
      const result = await runBackup({ db: dbPath, dataRoot: dataDir, to: join(root, 'backups') })

      const snap = new DatabaseSync(join(result.directory, 'database.sqlite'))
      try {
        const rows = snap.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>
        expect(rows.every(row => row.quick_check === 'ok')).toBe(true)
        const count = (snap.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n
        expect(count).toBe(1)
      } finally {
        snap.close()
      }
    } finally {
      auth.close()
    }
  })

  it('copies config with 0700 and never leaks secret values', async () => {
    const root = await tmp()
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { recursive: true })
    const dbPath = join(dataDir, 'gateway.sqlite')
    const auth = makeStore(dbPath)
    try {
      await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a sufficiently long password', role: 'user' })

      const configDir = join(root, 'etc', 'dsh-multiuser')
      await mkdir(configDir, { recursive: true })
      await writeFile(join(configDir, 'gateway.env'), 'DEEPSEEK_API_KEY=super-secret-value\n')

      const capture = captureStdout()
      let result
      try {
        result = await runBackup({ db: dbPath, dataRoot: dataDir, to: join(root, 'backups'), configDir })
      } finally {
        capture.restore()
      }

      const configTarget = join(result.directory, 'config')
      expect(existsSync(configTarget)).toBe(true)
      const mode = (await stat(configTarget)).mode & 0o777
      expect(mode).toBe(0o700)

      const output = capture.read()
      expect(output).not.toContain('super-secret-value')
      expect(output).toContain('secret material')

      const manifestText = await readFile(result.manifestPath, 'utf8')
      expect(manifestText).not.toContain('super-secret-value')
      expect(JSON.stringify(JSON.parse(manifestText))).not.toContain('super-secret-value')
    } finally {
      auth.close()
    }
  })

  it('rejects a destination inside the data root', async () => {
    const root = await tmp()
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { recursive: true })
    const dbPath = join(dataDir, 'gateway.sqlite')
    const auth = makeStore(dbPath)
    try {
      await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a sufficiently long password', role: 'user' })
      await expect(runBackup({ db: dbPath, dataRoot: dataDir, to: join(dataDir, 'inside') })).rejects.toThrow(/data root/iu)
    } finally {
      auth.close()
    }
  })

  it('rejects an existing regular file as the destination', async () => {
    const root = await tmp()
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { recursive: true })
    const dbPath = join(dataDir, 'gateway.sqlite')
    const auth = makeStore(dbPath)
    try {
      await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a sufficiently long password', role: 'user' })
      const fileDest = join(root, 'afile')
      await writeFile(fileDest, 'x')
      await expect(runBackup({ db: dbPath, dataRoot: dataDir, to: fileDest })).rejects.toThrow()
    } finally {
      auth.close()
    }
  })

  it('rejects when the database does not exist', async () => {
    const root = await tmp()
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { recursive: true })
    await expect(runBackup({ db: join(dataDir, 'nope.sqlite'), dataRoot: dataDir, to: join(root, 'backups') })).rejects.toThrow(/database not found/iu)
  })

  it('rejects when the data root does not exist', async () => {
    const root = await tmp()
    const dbPath = join(root, 'gateway.sqlite')
    await writeFile(dbPath, '')
    const dataDir = join(root, 'data')
    await expect(runBackup({ db: dbPath, dataRoot: dataDir, to: join(root, 'backups') })).rejects.toThrow(/data root not found/iu)
  })

  it('uses a unique directory when two backups share the same second', async () => {
    const root = await tmp()
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { recursive: true })
    const dbPath = join(dataDir, 'gateway.sqlite')
    const auth = makeStore(dbPath)
    try {
      await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a sufficiently long password', role: 'user' })

      // A fixed clock makes both runs land on the same second.
      const clock = new Date(0)
      const expectedStamp = clock.toISOString().replace(/[-:]/gu, '').replace(/\.\d+/u, '')

      const first = await runBackup({ db: dbPath, dataRoot: dataDir, to: join(root, 'backups'), now: () => clock })
      const second = await runBackup({ db: dbPath, dataRoot: dataDir, to: join(root, 'backups'), now: () => clock })

      expect(first.directory).toBe(join(root, 'backups', expectedStamp))
      expect(second.directory).toBe(join(root, 'backups', `${expectedStamp}-2`))
      expect(first.directory).not.toBe(second.directory)

      // Each snapshot is intact and independent (the second did not overwrite the first).
      for (const directory of [first.directory, second.directory]) {
        const snap = new DatabaseSync(join(directory, 'database.sqlite'))
        try {
          const rows = snap.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>
          expect(rows.every(row => row.quick_check === 'ok')).toBe(true)
        } finally {
          snap.close()
        }
      }
    } finally {
      auth.close()
    }
  })

  it('emits a single line of JSON when json is true', async () => {    const root = await tmp()
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { recursive: true })
    const dbPath = join(dataDir, 'gateway.sqlite')
    const auth = makeStore(dbPath)
    try {
      await auth.createUser({ username: 'alice', displayName: 'Alice', password: 'a sufficiently long password', role: 'user' })

      const capture = captureStdout()
      let result
      try {
        result = await runBackup({ db: dbPath, dataRoot: dataDir, to: join(root, 'backups'), json: true })
      } finally {
        capture.restore()
      }

      const out = capture.read()
      const nonEmpty = out.split('\n').filter(line => line.trim() !== '')
      expect(nonEmpty.length).toBe(1)
      const parsed = JSON.parse(nonEmpty[0] ?? '')
      expect(parsed.ok).toBe(true)
      expect(parsed.sha256).toBe(result.manifest.database.sha256)
    } finally {
      auth.close()
    }
  })
})
