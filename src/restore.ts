import { existsSync, readdirSync, statSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { chmodTree, copyTree, isInside, sha256File, verifySnapshot } from './backup.js'

export interface RestoreOptions {
  from: string
  dataRoot: string
  db?: string | undefined
  configDir?: string | undefined
  force?: boolean | undefined
  dryRun?: boolean | undefined
}

export interface RestoreResult {
  database: string
  /** Where the backed-up data root contents were expanded to (the data root itself). */
  users: string | null
  config: string | null
  /** Shared model configuration (`gateway.env` beside the database). */
  globalConfig: string | null
  /** Paths that pre-existing target data was moved to (never deleted). Ordered: data root, database, model config. */
  safetyCopies: string[]
  warnings: string[]
}

/** Minimal shape read from the backup manifest; other fields are ignored. */
interface ParsedManifest {
  database: { sha256: string }
  entries: Array<{ name: string }>
}

/**
 * Restore a gateway from a verified backup.
 *
 * Every check (manifest, integrity, openability, self-restore guard, target
 * emptiness) runs before any byte is written, so a failure never mutates the
 * target. With `--force` any pre-existing target data is *moved* aside (never
 * deleted) to a `.pre-restore-<stamp>` path, and the backup itself is never
 * touched. No secret values are ever printed.
 */
export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
  if (!isAbsolute(options.from)) throw new Error('--from must be an absolute path')
  const from = resolve(options.from)
  if (!existsSync(from)) throw new Error(`backup directory not found at ${from}`)
  const manifestPath = join(from, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`backup manifest not found at ${manifestPath}`)

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ParsedManifest
  if (typeof manifest?.database?.sha256 !== 'string') throw new Error('backup manifest is missing database.sha256')

  const dbSource = join(from, 'database.sqlite')
  if (!existsSync(dbSource)) throw new Error(`backup database snapshot not found at ${dbSource}`)

  // 2 & 3. Verify integrity and openability BEFORE touching the target. A sha
  // mismatch or a corrupt snapshot must leave the target byte-for-byte intact.
  const actualSha = await sha256File(dbSource)
  if (actualSha !== manifest.database.sha256) {
    throw new Error(`backup database sha256 mismatch: manifest ${manifest.database.sha256}, actual ${actualSha}`)
  }
  verifySnapshot(dbSource)

  // 4. Refuse to restore into the backup itself (would self-consume / clobber).
  const dataRoot = resolve(options.dataRoot)
  const db = resolve(options.db ?? join(dataRoot, 'gateway.sqlite'))
  if (isInside(db, from)) throw new Error(`target database ${db} must not be located inside the backup directory ${from}`)
  if (options.configDir !== undefined && isInside(resolve(options.configDir), from)) throw new Error('target config directory must not be located inside the backup directory')
  if (isInside(dataRoot, from)) throw new Error(`target data root ${dataRoot} must not be located inside the backup directory ${from}`)

  const usersSource = join(from, 'users')
  const usersPresent = existsSync(usersSource)
  const restoreConfig = options.configDir !== undefined
    && manifest.entries.some(entry => entry.name === 'config')
    && existsSync(join(from, 'config'))
  const configTarget = options.configDir !== undefined ? resolve(options.configDir) : null
  // The shared model configuration lives beside the database (`dirname(--db)`),
  // outside both the data root and the systemd config directory.
  const globalConfigSource = join(from, 'gateway.env')
  const globalConfigPresent = manifest.entries.some(entry => entry.name === 'gateway.env') && existsSync(globalConfigSource)
  const globalConfigTarget = join(dirname(db), 'gateway.env')
  if (globalConfigPresent && isInside(globalConfigTarget, from)) {
    throw new Error(`target model configuration ${globalConfigTarget} must not be located inside the backup directory ${from}`)
  }

  // 5. Plan safety copies when the target already holds data. Nothing that
  // already exists is ever overwritten in place or deleted: each such path is
  // *moved* to `<path>.pre-restore-<stamp>` first.
  //
  // The database needs its own aside-move because the documented layout keeps it
  // OUTSIDE the data root (`--db /var/lib/dsh-multiuser/gateway.sqlite` with
  // `--data-root /var/lib/dsh-multiuser/users`). Moving only the data root would
  // leave copyTree to clobber the previous database in place, destroying the one
  // artifact a rollback most needs.
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d+/u, '')
  const safetyMoves: Array<{ from: string; to: string }> = []
  const planSafetyCopy = (path: string): void => {
    const target = `${path}.pre-restore-${stamp}`
    if (existsSync(target)) throw new Error(`safety copy path ${target} already exists; aborting to avoid overwriting it`)
    safetyMoves.push({ from: path, to: target })
  }

  let nonEmptyDataRoot = false
  if (existsSync(dataRoot)) {
    nonEmptyDataRoot = statSync(dataRoot).isDirectory() ? readdirSync(dataRoot).length > 0 : true
  }
  // The database is already covered by the data-root move when it lives inside it.
  const dbNeedsOwnMove = existsSync(db) && !isInside(db, dataRoot)
  // The shared model configuration is likewise overwritten by the copy below.
  const globalConfigNeedsOwnMove = globalConfigPresent && existsSync(globalConfigTarget)

  if (nonEmptyDataRoot || dbNeedsOwnMove || globalConfigNeedsOwnMove) {
    if (options.force !== true) {
      const reason = nonEmptyDataRoot
        ? `target data root ${dataRoot} is not empty`
        : dbNeedsOwnMove
          ? `target database ${db} already exists`
          : `target model configuration ${globalConfigTarget} already exists`
      throw new Error(`${reason}; pass --force to move the existing data aside before restore`)
    }
    if (nonEmptyDataRoot) planSafetyCopy(dataRoot)
    if (dbNeedsOwnMove) planSafetyCopy(db)
    if (globalConfigNeedsOwnMove) planSafetyCopy(globalConfigTarget)
  }

  const warnings: string[] = []
  if (restoreConfig) {
    warnings.push('backup includes secret material (for example SSO private keys and gateway.env credentials); store and protect it like key material — no secret values are printed in this summary')
  }

  // The backup stores the *contents* of the data root under `<from>/users`
  // (`backup.ts` sets usersTarget = <backup>/users regardless of whether the
  // source was the data root itself or the fallback). Restore must therefore
  // expand them back onto the data root, NOT onto `<dataRoot>/users`: the
  // gateway expects per-user directories and `profile-template/` directly under
  // `--data-root` (`gateway.ts` profileTemplateCheck, `runtime-manager.ts`
  // userRoot). Nesting them one level deeper would leave every user invisible
  // and make /readyz fail PROFILE_TEMPLATE_MISSING.
  const plannedUsers = usersPresent ? dataRoot : null
  const plannedConfig = restoreConfig && configTarget !== null ? configTarget : null
  const plannedGlobalConfig = globalConfigPresent ? globalConfigTarget : null

  // Guard the most likely operator mistake: passing the data directory instead of
  // the data root. Under the canonical layout (<data-dir>/users is the data
  // root) that means <dataRoot>/users exists and is itself a data root.
  if (existsSync(join(dataRoot, 'users'))) {
    warnings.push(`target ${dataRoot} already contains a "users" directory; --data-root is expected to be the data root itself (for example /var/lib/dsh-multiuser/users), not its parent — the restored contents are written directly under ${dataRoot}`)
  }

  const safetyCopies = safetyMoves.map(move => move.to)

  if (options.dryRun === true) {
    const lines = ['restore plan (dry run — nothing will be modified)', `  - database: ${db}`]
    if (plannedUsers !== null) lines.push(`  - users: ${plannedUsers}`)
    if (plannedConfig !== null) lines.push(`  - config: ${plannedConfig}`)
    if (plannedGlobalConfig !== null) lines.push(`  - model config: ${plannedGlobalConfig}`)
    for (const copy of safetyCopies) lines.push(`  - safety copy (move existing data): ${copy}`)
    for (const warning of warnings) lines.push(`warning: ${warning}`)
    process.stdout.write(`${lines.join('\n')}\n`)
    return { database: db, users: plannedUsers, config: plannedConfig, globalConfig: plannedGlobalConfig, safetyCopies, warnings }
  }

  // 7. Write: move existing data aside first, then restore (never delete the backup).
  for (const move of safetyMoves) await rename(move.from, move.to)
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  await copyTree(dbSource, db)
  await chmod(db, 0o600).catch(() => undefined)
  if (usersPresent) await copyTree(usersSource, dataRoot)
  if (restoreConfig && configTarget !== null) {
    await copyTree(join(from, 'config'), configTarget)
    await chmodTree(configTarget, 0o700, 0o600)
  }
  if (globalConfigPresent) {
    await copyFile(globalConfigSource, plannedGlobalConfig as string)
    await chmod(plannedGlobalConfig as string, 0o600)
  }

  // Post-write invariant: a backing-up data root always carries profile-template,
  // and the gateway refuses to serve without it at <dataRoot>/profile-template.
  // If it is absent after a copy that reported success, the restored root is not
  // one the gateway can use — fail loudly instead of reporting a silent success.
  if (existsSync(join(usersSource, 'profile-template')) && !existsSync(join(dataRoot, 'profile-template'))) {
    const moved = safetyCopies.length === 0 ? '' : `; the pre-existing data was moved to ${safetyCopies.join(', ')}`
    throw new Error(`restore verification failed: ${join(usersSource, 'profile-template')} exists in the backup but ${join(dataRoot, 'profile-template')} is missing after restore${moved}`)
  }

  const lines = [`restore: database -> ${db}`]
  if (plannedUsers !== null) lines.push(`restore: users -> ${plannedUsers}`)
  if (plannedConfig !== null) lines.push(`restore: config -> ${plannedConfig}`)
  if (plannedGlobalConfig !== null) lines.push(`restore: model config -> ${plannedGlobalConfig}`)
  for (const copy of safetyCopies) lines.push(`existing data moved to ${copy} (not deleted)`)
  for (const warning of warnings) lines.push(`warning: ${warning}`)
  process.stdout.write(`${lines.join('\n')}\n`)

  return { database: db, users: plannedUsers, config: plannedConfig, globalConfig: plannedGlobalConfig, safetyCopies, warnings }
}
