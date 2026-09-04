import { cp, lstat, mkdir, readFile, readdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const USER_OWNED_PROFILE_FILES = new Set(['cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])

/** Synchronize deployment-owned Profile files without touching user Runtime data. */
export async function prepareUserProfile(source: string, dshHome: string, legacyPresetSource?: string): Promise<void> {
  const profileSource = resolve(source)
  const home = resolve(dshHome)
  const profileTarget = join(home, 'profiles', 'user-runtime')
  const profileExists = existsSync(profileTarget)
  const publicStatePath = join(home, '.dsh-multiuser', 'public-profile.json')
  const existingManifest = await readProfileManifest(join(profileTarget, 'package.json'))
  const previousPublicManifest = await readProfileManifest(publicStatePath)
  const publicManifest = await readProfileManifest(join(profileSource, 'package.json'))
  await cp(profileSource, profileTarget, {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: sourcePath => {
      const parts = relative(profileSource, sourcePath).split(sep)
      if (parts.includes('node_modules')) return false
      return !profileExists || parts.length !== 1 || !USER_OWNED_PROFILE_FILES.has(parts[0]!)
    },
  })
  if (publicManifest !== undefined) {
    await writeFile(join(profileTarget, 'package.json'), JSON.stringify(mergeProfileManifests(publicManifest, existingManifest, previousPublicManifest), undefined, 2) + '\n')
    await mkdir(dirname(publicStatePath), { recursive: true })
    await writeFile(publicStatePath, JSON.stringify(publicManifest, undefined, 2) + '\n')
  }
  await syncProfileNodeModules(join(profileSource, 'node_modules'), join(profileTarget, 'node_modules'))
  await ensureLegacyPreset(home, legacyPresetSource)
  const packageSource = resolve(profileSource, '../../packages')
  const packageTarget = join(home, 'packages')
  if (existsSync(packageSource)) await cp(packageSource, packageTarget, { recursive: true, force: true })
  const bundleSource = resolve(profileSource, '../../packages/bundle/user-runtime')
  const bundleTarget = join(home, 'packages/bundle/user-runtime')
  await cp(bundleSource, bundleTarget, { recursive: true, force: true })
  const moduleTarget = join(profileTarget, 'node_modules/@dsh-multiuser/user-runtime-bundle')
  await mkdir(dirname(moduleTarget), { recursive: true })
  try {
    const existing = await lstat(moduleTarget)
    if (!existing.isSymbolicLink()) throw new Error(`profile module target is not a symlink: ${moduleTarget}`)
    const link = await readlink(moduleTarget)
    const linkedTarget = isAbsolute(link) ? link : resolve(dirname(moduleTarget), link)
    if (resolve(linkedTarget) === resolve(bundleTarget)) return
    await unlink(moduleTarget)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await symlink(bundleTarget, moduleTarget, 'dir')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await lstat(moduleTarget)
    if (!existing.isSymbolicLink()) throw new Error(`profile module target is not a symlink: ${moduleTarget}`)
  }
}

interface ProfileManifest {
  readonly [key: string]: unknown
  readonly dependencies?: Record<string, string>
  readonly dsh?: {
    readonly [key: string]: unknown
    readonly profile?: {
      readonly [key: string]: unknown
      readonly bundles?: string[]
    }
  }
}

async function readProfileManifest(path: string): Promise<ProfileManifest | undefined> {
  if (!existsSync(path)) return undefined
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`profile manifest must hold a JSON object: ${path}`)
  }
  return parsed as ProfileManifest
}

function mergeProfileManifests(
  publicManifest: ProfileManifest,
  existingManifest: ProfileManifest | undefined,
  previousPublicManifest: ProfileManifest | undefined,
): ProfileManifest {
  if (existingManifest === undefined) return publicManifest
  const publicBundles = publicManifest.dsh?.profile?.bundles ?? []
  const previouslyPublicDependencies = new Set(Object.keys(previousPublicManifest?.dependencies ?? publicManifest.dependencies ?? {}))
  const privateDependencies = Object.fromEntries(
    Object.entries(existingManifest.dependencies ?? {}).filter(([name]) => !previouslyPublicDependencies.has(name)),
  )
  const previouslyPublicBundles = new Set(previousPublicManifest?.dsh?.profile?.bundles ?? publicBundles)
  const currentPublicBundles = new Set(publicBundles)
  const privateBundles = (existingManifest.dsh?.profile?.bundles ?? []).filter(bundle =>
    !previouslyPublicBundles.has(bundle) && !currentPublicBundles.has(bundle))
  return {
    ...existingManifest,
    ...publicManifest,
    dependencies: { ...privateDependencies, ...publicManifest.dependencies },
    dsh: {
      ...existingManifest.dsh,
      ...publicManifest.dsh,
      profile: {
        ...existingManifest.dsh?.profile,
        ...publicManifest.dsh?.profile,
        bundles: [...publicBundles, ...privateBundles],
      },
    },
  }
}

async function syncProfileNodeModules(source: string, target: string): Promise<void> {
  if (!existsSync(source)) return
  try {
    if ((await lstat(target)).isSymbolicLink()) await unlink(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(target, { recursive: true })
  await copyNodeModulesTree(source, target)
}

async function copyNodeModulesTree(source: string, target: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (relative(source, join(source, entry.name)) === join('@dsh-multiuser', 'user-runtime-bundle')) continue
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    if (entry.isSymbolicLink()) {
      try { await unlink(targetPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const link = await readlink(sourcePath)
      await symlink(isAbsolute(link) ? link : resolve(dirname(sourcePath), link), targetPath, 'junction')
    } else if (entry.isDirectory()) {
      try {
        if ((await lstat(targetPath)).isSymbolicLink()) await unlink(targetPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await mkdir(targetPath, { recursive: true })
      await copyNodeModulesTree(sourcePath, targetPath)
    } else {
      await cp(sourcePath, targetPath, { force: true })
    }
  }
}

/** Create the shared template Profile once; later plugin commands own its manifest. */
export async function prepareProfileTemplate(source: string, templateHome: string, legacyPresetSource?: string): Promise<void> {
  const profile = join(resolve(templateHome), 'profiles', 'user-runtime')
  if (!existsSync(profile)) {
    await prepareUserProfile(source, templateHome, legacyPresetSource)
    return
  }
  // Keep deployment-owned Bundle files current while preserving the template
  // Profile manifest, which is managed by the public plugin commands.
  const bundleSource = resolve(source, '../../packages/bundle/user-runtime')
  const bundleTarget = join(resolve(templateHome), 'packages/bundle/user-runtime')
  await cp(bundleSource, bundleTarget, { recursive: true, force: true })
  await ensureLegacyPreset(templateHome, legacyPresetSource)
}

async function ensureLegacyPreset(dshHome: string, legacyPresetSource?: string): Promise<void> {
  const target = join(resolve(dshHome), '.agent-presets', 'code')
  if (legacyPresetSource === undefined || !existsSync(legacyPresetSource) || existsSync(target)) return
  await cp(resolve(legacyPresetSource), target, { recursive: true })
}
