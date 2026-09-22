import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readlink, readdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { packageRoot, readCompatibility } from './install.js'

export interface BackupOptions {
  db: string
  dataRoot: string
  to: string
  configDir?: string | undefined
  json?: boolean | undefined
  now?: (() => Date) | undefined
}

export interface BackupEntry {
  kind: 'file' | 'directory'
  name: string
  bytes: number
  files: number
}

export interface BackupManifest {
  createdAt: string
  app: { name: string; version: string }
  node: string
  dsh: { tested: string[]; canary: string[] }
  database: { source: string; snapshot: string; sha256: string; bytes: number }
  entries: BackupEntry[]
  warnings: string[]
}

export interface BackupResult {
  directory: string
  manifest: BackupManifest
  manifestPath: string
}

/** Compute the SHA-256 hex digest of a file by streaming it. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Recursively total bytes and file count of a tree. Symbolic links are treated
 * as a single file (link size) and never followed, matching the copy policy.
 */
function treeStats(path: string): { bytes: number; files: number } {
  const info = lstatSync(path)
  if (info.isDirectory()) {
    let bytes = 0
    let files = 0
    for (const name of readdirSync(path)) {
      const sub = treeStats(join(path, name))
      bytes += sub.bytes
      files += sub.files
    }
    return { bytes, files }
  }
  return { bytes: info.size, files: 1 }
}

/**
 * Copy a tree preserving permissions. Symbolic links are recreated as links and
 * are never followed, so a symlinked directory is backed up as a link only.
 */
export async function copyTree(source: string, target: string): Promise<void> {
  const info = lstatSync(source)
  if (info.isSymbolicLink()) {
    const link = await readlink(source)
    await symlink(link, target)
    return
  }
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true })
    await chmod(target, info.mode & 0o777).catch(() => undefined)
    for (const name of await readdir(source)) {
      await copyTree(join(source, name), join(target, name))
    }
    return
  }
  await copyFile(source, target)
  await chmod(target, info.mode & 0o777).catch(() => undefined)
}

/** Recursively set owner-only access on a copied config tree. */
export async function chmodTree(root: string, dirMode: number, fileMode: number): Promise<void> {
  const info = lstatSync(root)
  if (info.isDirectory()) {
    await chmod(root, dirMode)
    for (const name of readdirSync(root)) await chmodTree(join(root, name), dirMode, fileMode)
  } else if (!info.isSymbolicLink()) {
    await chmod(root, fileMode).catch(() => undefined)
  }
}

/** True when `child` resolves to a path at or under `parent`. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Reopen a snapshot and assert it is internally consistent, then close it. */
export function verifySnapshot(path: string): void {
  const check = new DatabaseSync(path)
  try {
    const rows = check.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>
    for (const row of rows) {
      if (row.quick_check !== 'ok') throw new Error(`database quick_check reported: ${row.quick_check}`)
    }
    // Confirms the users table is present and readable after the snapshot.
    check.prepare('SELECT count(*) AS n FROM users').get()
  } finally {
    check.close()
  }
}

/**
 * Create a consistent, restart-safe backup of a running gateway.
 *
 * The database is captured with `VACUUM INTO`, which yields a single-file
 * snapshot of all committed data even while the gateway holds the database
 * open in WAL mode; a raw `cp` would risk a torn or stale copy. The users tree
 * and (optionally) the config tree are copied read-only into a timestamped
 * directory under `--to`, and a 0600 manifest is written. No secret values are
 * ever printed.
 */
export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  if (!isAbsolute(options.to)) throw new Error('--to must be an absolute path')
  const to = resolve(options.to)
  const dataRoot = resolve(options.dataRoot)
  const db = resolve(options.db)

  // The destination must never live inside the data root or the application tree.
  // Note: a path that is a *parent* (or sibling) of the data root is allowed —
  // isInside only blocks backups written inside dataRoot (which would self-consume
  // on restore), not ancestors. The deployment manual recommends keeping backups
  // entirely outside the data directory.
  if (isInside(to, dataRoot)) throw new Error(`--to ${to} must not be located inside the data root ${dataRoot}`)
  if (isInside(to, packageRoot())) throw new Error(`--to ${to} must not be located inside the application directory`)

  // Reject a destination parent that already exists as a regular file.
  if (existsSync(to)) {
    if (!statSync(to).isDirectory()) throw new Error(`--to ${to} exists and is not a directory`)
  } else {
    await mkdir(to, { recursive: true })
  }

  // Source data must exist: never silently produce an empty backup.
  if (!existsSync(db)) throw new Error(`database not found at ${db}`)
  if (!existsSync(dataRoot)) throw new Error(`data root not found at ${dataRoot}`)

  const warnings: string[] = []

  // 1. Consistent database snapshot via VACUUM INTO (safe while the gateway runs).
  const now = options.now ?? (() => new Date())
  const stamp = now().toISOString().replace(/[-:]/gu, '').replace(/\.\d+/u, '')
  // A collision within the same second (e.g. a script retry) must not clobber an
  // existing backup with an opaque SQLite error from VACUUM INTO; append a numeric
  // suffix until a free directory is found. The cap avoids an accidental loop.
  let directory = join(to, stamp)
  for (let attempt = 2; existsSync(directory); attempt++) {
    if (attempt > 100) throw new Error(`too many backups share the same second at ${to}; aborting to avoid an ambiguous collision`)
    directory = join(to, `${stamp}-${String(attempt)}`)
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const snapshotPath = join(directory, 'database.sqlite')
  const source = new DatabaseSync(db)
  try {
    source.exec(`VACUUM INTO '${snapshotPath.replace(/'/gu, "''")}'`)
  } finally {
    source.close()
  }
  verifySnapshot(snapshotPath)
  const sha256 = await sha256File(snapshotPath)
  const dbBytes = statSync(snapshotPath).size

  // WAL/SHM are intentionally not copied: VACUUM INTO already contains all
  // committed data, so uncommitted WAL content is excluded by design.
  if (existsSync(`${db}-wal`) || existsSync(`${db}-shm`)) {
    warnings.push('gateway.sqlite WAL/SHM were not copied separately because VACUUM INTO already includes all committed data; uncommitted WAL content is excluded by design')
  }

  const entries: BackupEntry[] = []
  entries.push({ kind: 'file', name: 'database.sqlite', bytes: dbBytes, files: 1 })

  // 1b. The shared model configuration the admin UI writes.
  //
  // The gateway defaults `--gateway-env` to `dirname(--db)/gateway.env` (see
  // gateway-cli.ts), which is a DIFFERENT file from the systemd
  // `EnvironmentFile` under `--config-dir`. It is not under `--data-root`
  // either, so a plain db+data-root+config-dir backup drops it and a restore
  // silently comes back with no model credentials. Captured as its own entry,
  // unless --config-dir already covers it.
  const globalConfigSource = join(dirname(db), 'gateway.env')
  const coveredByConfigDir = options.configDir !== undefined
    && isInside(globalConfigSource, resolve(options.configDir))
  if (existsSync(globalConfigSource) && !isInside(globalConfigSource, dataRoot) && !coveredByConfigDir) {
    const globalConfigTarget = join(directory, 'gateway.env')
    await copyFile(globalConfigSource, globalConfigTarget)
    await chmod(globalConfigTarget, 0o600)
    entries.push({ kind: 'file', name: 'gateway.env', bytes: statSync(globalConfigTarget).size, files: 1 })
    warnings.push('backup includes the shared model configuration (gateway.env beside the database); store and protect it like key material — no secret values are printed in this summary')
  }

  // 2. Copy the users tree, preserving permissions and links without following them.
  const usersSource = existsSync(join(dataRoot, 'users')) ? join(dataRoot, 'users') : dataRoot
  const usersTarget = join(directory, 'users')
  if (existsSync(usersSource)) {
    await copyTree(usersSource, usersTarget)
    const stats = treeStats(usersTarget)
    entries.push({ kind: 'directory', name: 'users', bytes: stats.bytes, files: stats.files })
  }

  // 3. Copy config (may contain secrets), restricted to owner-only access.
  if (options.configDir !== undefined && existsSync(options.configDir)) {
    const configTarget = join(directory, 'config')
    await copyTree(options.configDir, configTarget)
    await chmodTree(configTarget, 0o700, 0o600)
    const stats = treeStats(configTarget)
    entries.push({ kind: 'directory', name: 'config', bytes: stats.bytes, files: stats.files })
    warnings.push('backup includes secret material (for example SSO private keys and gateway.env credentials); store and protect it like key material — no secret values are printed in this summary')
  }

  // 4. Write the manifest (0600).
  const pkg = JSON.parse(await readFile(join(packageRoot(), 'package.json'), 'utf8')) as { name?: string; version?: string }
  const compatibility = await readCompatibility()
  const manifest: BackupManifest = {
    createdAt: now().toISOString(),
    app: { name: pkg.name ?? 'dsh-multiuser', version: pkg.version ?? '0.0.0' },
    node: process.version,
    dsh: { tested: compatibility.testedDshVersions, canary: compatibility.canaryDshVersions },
    database: { source: db, snapshot: snapshotPath, sha256, bytes: dbBytes },
    entries,
    warnings,
  }
  const manifestPath = join(directory, 'manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await chmod(manifestPath, 0o600)

  // Human-readable summary (no secret values) or a single line of JSON.
  if (options.json === true) {
    const summary = {
      ok: true,
      directory,
      manifestPath,
      createdAt: manifest.createdAt,
      sha256,
      bytes: dbBytes,
      entries: manifest.entries.map(entry => entry.name),
      warnings: manifest.warnings,
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`)
  } else {
    const lines: string[] = []
    lines.push(`backup created: ${directory}`)
    lines.push(`database snapshot: ${snapshotPath} (${String(dbBytes)} bytes, sha256 ${sha256})`)
    for (const entry of entries) {
      if (entry.kind === 'directory') lines.push(`  directory ${entry.name}: ${String(entry.files)} files, ${String(entry.bytes)} bytes`)
      else lines.push(`  file ${entry.name}: ${String(entry.bytes)} bytes`)
    }
    for (const warning of warnings) lines.push(`warning: ${warning}`)
    process.stdout.write(`${lines.join('\n')}\n`)
  }

  return { directory, manifest, manifestPath }
}
