import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareProfileTemplate, prepareUserProfile } from '../src/user-profile.js'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function fixture(): Promise<{ source: string; home: string; bundlePatch: string; legacyPreset: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-multiuser-profile-'))
  directories.push(root)
  const source = join(root, 'app', 'profiles', 'user-runtime')
  const bundlePatch = join(root, 'app', 'packages', 'bundle', 'user-runtime', 'cordis.patch.yml')
  const legacyPreset = join(root, 'harness', 'packages', 'preset', 'agent-presets', 'presets', 'ptc')
  await mkdir(source, { recursive: true })
  await mkdir(dirname(bundlePatch), { recursive: true })
  await writeFile(join(source, 'package.json'), '{"name":"profile"}\n')
  await writeFile(bundlePatch, '[]\n')
  await mkdir(legacyPreset, { recursive: true })
  await writeFile(join(legacyPreset, 'agent.cordis.yml'), '- id: ptc\n')
  return { source, home: join(root, 'users', 'user', 'dsh-home'), bundlePatch, legacyPreset }
}

describe('prepareUserProfile', () => {
  it('refreshes the deployment Bundle in an existing template', async () => {
    const { source, home, bundlePatch } = await fixture()
    await prepareProfileTemplate(source, home)
    await writeFile(bundlePatch, '- id: llm-pi-ai\n')

    await prepareProfileTemplate(source, home)

    expect(await readFile(join(home, 'packages', 'bundle', 'user-runtime', 'cordis.patch.yml'), 'utf8')).toBe('- id: llm-pi-ai\n')
  })

  it('preserves public plugins already installed in the persistent template', async () => {
    const { source, home } = await fixture()
    await prepareProfileTemplate(source, home)
    const profile = join(home, 'profiles', 'user-runtime')
    const installedManifest = {
      name: 'profile',
      dependencies: { 'persistent-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'persistent-plugin'] } },
    }
    await writeFile(join(profile, 'package.json'), JSON.stringify(installedManifest, undefined, 2) + '\n')
    await mkdir(join(profile, 'node_modules', 'persistent-plugin'), { recursive: true })
    await writeFile(join(profile, 'node_modules', 'persistent-plugin', 'package.json'), '{"name":"persistent-plugin"}\n')

    await prepareProfileTemplate(source, home)

    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))).toEqual(installedManifest)
    expect(await readFile(join(profile, 'node_modules', 'persistent-plugin', 'package.json'), 'utf8')).toBe('{"name":"persistent-plugin"}\n')
  })

  it('updates deployment files while preserving the Profile module link and user data', async () => {
    const { source, home, bundlePatch } = await fixture()
    await prepareUserProfile(source, home)
    const moduleTarget = join(home, 'profiles', 'user-runtime', 'node_modules', '@dsh-multiuser', 'user-runtime-bundle')
    const userSettings = join(home, 'settings', 'user.json')
    await mkdir(dirname(userSettings), { recursive: true })
    await writeFile(userSettings, '{"credential":"user-owned"}\n')
    await writeFile(bundlePatch, '- id: settings\n')

    await prepareUserProfile(source, home)

    expect(await readFile(join(home, 'packages', 'bundle', 'user-runtime', 'cordis.patch.yml'), 'utf8')).toBe('- id: settings\n')
    expect(await readFile(userSettings, 'utf8')).toBe('{"credential":"user-owned"}\n')
    expect(await readFile(join(moduleTarget, 'cordis.patch.yml'), 'utf8')).toBe('- id: settings\n')
  })

  it('repairs a stale module link without failing when it already exists', async () => {
    const { source, home } = await fixture()
    const stale = join(home, 'stale-bundle')
    const moduleTarget = join(home, 'profiles', 'user-runtime', 'node_modules', '@dsh-multiuser', 'user-runtime-bundle')
    await mkdir(stale, { recursive: true })
    await mkdir(dirname(moduleTarget), { recursive: true })
    await symlink(stale, moduleTarget, 'dir')

    await prepareUserProfile(source, home)

    expect(await readFile(join(moduleTarget, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
  })

  it('preserves external package links without following them during profile preparation', async () => {
    const { source, home } = await fixture()
    const packageDirectory = join(home, '..', 'shared-package')
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(join(packageDirectory, 'package.json'), '{"name":"dsh-better-sidebar"}\n')
    await mkdir(join(source, 'node_modules'), { recursive: true })
    await symlink(relative(join(source, 'node_modules'), packageDirectory), join(source, 'node_modules', 'dsh-better-sidebar'), 'dir')

    await prepareUserProfile(source, home)

    const copiedLink = join(home, 'profiles', 'user-runtime', 'node_modules', 'dsh-better-sidebar')
    expect(await readlink(copiedLink)).toBe(packageDirectory)
    expect(await readFile(join(copiedLink, 'package.json'), 'utf8')).toBe('{"name":"dsh-better-sidebar"}\n')
  })

  it('preserves a user-installed private plugin when refreshing public plugins', async () => {
    const { source, home } = await fixture()
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'profile',
      dependencies: { 'public-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['public-plugin'] } },
    }, undefined, 2) + '\n')
    await prepareUserProfile(source, home)

    const target = join(home, 'profiles', 'user-runtime')
    await writeFile(join(target, 'package.json'), JSON.stringify({
      name: 'profile',
      dependencies: { 'public-plugin': '^1.0.0', 'private-plugin': '^2.0.0' },
      dsh: { profile: { bundles: ['public-plugin', 'private-plugin'] } },
    }, undefined, 2) + '\n')
    await mkdir(join(target, 'node_modules', 'private-plugin'), { recursive: true })
    await writeFile(join(target, 'node_modules', 'private-plugin', 'package.json'), '{"name":"private-plugin"}\n')

    await prepareUserProfile(source, home)

    expect(JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { 'public-plugin': '^1.0.0', 'private-plugin': '^2.0.0' },
      dsh: { profile: { bundles: ['public-plugin', 'private-plugin'] } },
    })
    expect(await readFile(join(target, 'node_modules', 'private-plugin', 'package.json'), 'utf8')).toBe('{"name":"private-plugin"}\n')
  })

  it('removes retired public plugins without removing private plugins', async () => {
    const { source, home } = await fixture()
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'profile',
      dependencies: { 'public-plugin': '^1.0.0', 'retired-public-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['public-plugin', 'retired-public-plugin'] } },
    }, undefined, 2) + '\n')
    await prepareUserProfile(source, home)

    const target = join(home, 'profiles', 'user-runtime')
    await writeFile(join(target, 'package.json'), JSON.stringify({
      name: 'profile',
      dependencies: {
        'public-plugin': '^1.0.0',
        'retired-public-plugin': '^1.0.0',
        'private-plugin': '^2.0.0',
      },
      dsh: { profile: { bundles: ['public-plugin', 'retired-public-plugin', 'private-plugin'] } },
    }, undefined, 2) + '\n')
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'profile',
      dependencies: { 'public-plugin': '^1.1.0' },
      dsh: { profile: { bundles: ['public-plugin'] } },
    }, undefined, 2) + '\n')

    await prepareUserProfile(source, home)

    expect(JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { 'public-plugin': '^1.1.0', 'private-plugin': '^2.0.0' },
      dsh: { profile: { bundles: ['public-plugin', 'private-plugin'] } },
    })
    expect(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).dependencies).not.toHaveProperty('retired-public-plugin')
  })

  it('promotes a private plugin to public without duplicating its Bundle', async () => {
    const { source, home } = await fixture()
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'profile',
      dependencies: { 'public-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['public-plugin'] } },
    }, undefined, 2) + '\n')
    await prepareUserProfile(source, home)

    const target = join(home, 'profiles', 'user-runtime')
    await writeFile(join(target, 'package.json'), JSON.stringify({
      name: 'profile',
      dependencies: { 'public-plugin': '^1.0.0', 'promoted-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['public-plugin', 'promoted-plugin'] } },
    }, undefined, 2) + '\n')
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'profile',
      dependencies: { 'public-plugin': '^1.0.0', 'promoted-plugin': '^2.0.0' },
      dsh: { profile: { bundles: ['public-plugin', 'promoted-plugin'] } },
    }, undefined, 2) + '\n')

    await prepareUserProfile(source, home)

    expect(JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { 'public-plugin': '^1.0.0', 'promoted-plugin': '^2.0.0' },
      dsh: { profile: { bundles: ['public-plugin', 'promoted-plugin'] } },
    })
  })

  it('preserves private plugin lock, build approval, and patch files', async () => {
    const { source, home } = await fixture()
    await writeFile(join(source, 'pnpm-lock.yaml'), 'public-lock\n')
    await writeFile(join(source, 'pnpm-workspace.yaml'), 'allowBuilds:\n  public-native: true\n')
    await prepareUserProfile(source, home)

    const target = join(home, 'profiles', 'user-runtime')
    await writeFile(join(target, 'pnpm-lock.yaml'), 'private-lock\n')
    await writeFile(join(target, 'pnpm-workspace.yaml'), 'allowBuilds:\n  private-native: true\n')
    await writeFile(join(target, 'cordis.patch.yml'), '- id: private-plugin\n')
    await writeFile(join(source, 'pnpm-lock.yaml'), 'updated-public-lock\n')
    await writeFile(join(source, 'pnpm-workspace.yaml'), 'allowBuilds:\n  updated-public-native: true\n')

    await prepareUserProfile(source, home)

    expect(await readFile(join(target, 'pnpm-lock.yaml'), 'utf8')).toBe('private-lock\n')
    expect(await readFile(join(target, 'pnpm-workspace.yaml'), 'utf8')).toBe('allowBuilds:\n  private-native: true\n')
    expect(await readFile(join(target, 'cordis.patch.yml'), 'utf8')).toBe('- id: private-plugin\n')
  })

  it('adds the legacy code preset alias without overwriting a user preset', async () => {
    const { source, home, legacyPreset } = await fixture()
    await prepareUserProfile(source, home, legacyPreset)

    const alias = join(home, '.agent-presets', 'code', 'agent.cordis.yml')
    expect(await readFile(alias, 'utf8')).toBe('- id: ptc\n')
    await writeFile(alias, '- id: user-owned\n')
    await prepareUserProfile(source, home, legacyPreset)
    expect(await readFile(alias, 'utf8')).toBe('- id: user-owned\n')
  })
})
