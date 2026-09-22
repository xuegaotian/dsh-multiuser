import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GlobalConfigStore } from '../src/global-config.js'
import { PublicSkillStore } from '../src/public-content.js'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

describe('GlobalConfigStore', () => {
  it('stores shared model configuration without returning the API key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-multiuser-global-config-'))
    directories.push(directory)
    const store = new GlobalConfigStore(join(directory, 'gateway.env'))
    expect(await store.describe()).toEqual({ apiKeyConfigured: false })
    await store.save({ apiKey: 'shared-key', baseUrl: 'https://example.test' })
    expect(await store.describe()).toEqual({ apiKeyConfigured: true, baseUrl: 'https://example.test' })
    expect(await store.runtimeEnvironment()).toEqual({ DEEPSEEK_API_KEY: 'shared-key', DEEPSEEK_BASE_URL: 'https://example.test' })
  })

  it('serializes custom providers with the provider id only as the dictionary key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-multiuser-global-config-'))
    directories.push(directory)
    const store = new GlobalConfigStore(join(directory, 'gateway.env'))
    await store.save({
      apiKey: 'shared-key',
      providers: [{ provider: 'acme', api: 'openai-completions', baseURL: 'https://example.test/v1', models: [{ id: 'glm-5.3' }], apiKey: 'acme-key' }],
    })

    const environment = await store.runtimeEnvironment()
    const providers = JSON.parse(environment.DSH_PUBLIC_LLM_PROVIDERS!) as Record<string, Record<string, unknown>>
    expect(providers.acme).toMatchObject({ apiKeyEnv: 'DSH_PUBLIC_LLM_KEY_ACME', api: 'openai-completions', baseURL: 'https://example.test/v1' })
    expect(providers.acme).not.toHaveProperty('provider')
  })
})

describe('PublicSkillStore', () => {
  it('writes and removes one shared Skill bundle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-multiuser-public-skill-'))
    directories.push(directory)
    const store = new PublicSkillStore(directory)
    await store.save('release-check', '---\nname: release-check\ndescription: Release checks\n---\n')
    expect(await store.list()).toEqual([{ name: 'release-check', content: '---\nname: release-check\ndescription: Release checks\n---\n', files: ['SKILL.md'] }])
    await store.remove('release-check')
    expect(await store.list()).toEqual([])
  })

  it('imports complete Skill directories with scripts and references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-multiuser-public-skill-'))
    directories.push(directory)
    const store = new PublicSkillStore(directory)
    await store.import('release-check', [
      { path: 'SKILL.md', content: Buffer.from('---\nname: release-check\ndescription: Release checks\n---\n').toString('base64') },
      { path: 'scripts/check.sh', content: Buffer.from('#!/bin/sh\necho ok\n').toString('base64') },
      { path: 'references/policy.md', content: Buffer.from('# Policy\n').toString('base64') },
    ])
    expect((await store.list())[0]).toMatchObject({ name: 'release-check', files: ['SKILL.md', 'references/policy.md', 'scripts/check.sh'] })
    expect(await readFile(join(directory, 'skills', 'release-check', 'scripts', 'check.sh'), 'utf8')).toContain('echo ok')
    await expect(store.import('release-check', [{ path: '../SKILL.md', content: 'YQ==' }])).rejects.toThrow('skill file path is invalid')
  })

  it('keeps existing Skills when the store is opened again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-multiuser-public-skill-'))
    directories.push(directory)
    await new PublicSkillStore(directory).save('release-check', '---\nname: release-check\ndescription: Release checks\n---\n')

    expect(await new PublicSkillStore(directory).list()).toEqual([
      expect.objectContaining({ name: 'release-check', files: ['SKILL.md'] }),
    ])
  })
})
