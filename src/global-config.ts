import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface GlobalModelConfig {
  apiKeyConfigured: boolean
  baseUrl?: string
  providers?: PublicProviderConfig[]
}

export interface PublicProviderModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

export interface PublicProviderConfig {
  provider: string
  displayName?: string
  api: string
  baseURL: string
  models: PublicProviderModel[]
  apiKeyConfigured: boolean
}

interface StoredProviderConfig extends Omit<PublicProviderConfig, 'apiKeyConfigured'> {
  apiKeyEnv: string
}

function parse(content: string): Record<string, string> {
  return Object.fromEntries(content.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .flatMap(line => {
      const separator = line.indexOf('=')
      return separator < 1 ? [] : [[line.slice(0, separator), decodeEnvValue(line.slice(separator + 1))]]
    }))
}

/** Deployment-owned, mode-0600 Gateway configuration for shared model access. */
export class GlobalConfigStore {
  constructor(private readonly path: string) {}

  /** Return the public model configuration without exposing secret values. */
  async describe(): Promise<GlobalModelConfig> {
    const values = await this.read()
    const baseUrl = values.DEEPSEEK_BASE_URL?.trim()
    const providers = parseProviders(values.DSH_PUBLIC_LLM_PROVIDERS)
    const publicProviders = providers.map(({ apiKeyEnv: _apiKeyEnv, ...provider }) => ({ provider: provider.provider, ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }), api: provider.api, baseURL: provider.baseURL, models: provider.models, apiKeyConfigured: values[providerApiKeyEnv(provider.provider)]?.trim() !== undefined && values[providerApiKeyEnv(provider.provider)]!.trim() !== '' }))
    return { apiKeyConfigured: values.DEEPSEEK_API_KEY?.trim() !== undefined && values.DEEPSEEK_API_KEY.trim() !== '', ...(baseUrl === undefined || baseUrl === '' ? {} : { baseUrl }), ...(publicProviders.length === 0 ? {} : { providers: publicProviders }) }
  }

  /** Build the inherited Runtime environment from the currently saved configuration. */
  async runtimeEnvironment(): Promise<Record<string, string>> {
    const values = await this.read()
    const providers = parseProviders(values.DSH_PUBLIC_LLM_PROVIDERS)
    const providerConfig = Object.fromEntries(providers.map(({ provider, ...config }) => [provider, config]))
    return Object.fromEntries(Object.entries({ DEEPSEEK_API_KEY: values.DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL: values.DEEPSEEK_BASE_URL, ...(providers.length === 0 ? {} : { DSH_PUBLIC_LLM_PROVIDERS: JSON.stringify(providerConfig) }), ...Object.fromEntries(providers.map(provider => [provider.apiKeyEnv, values[provider.apiKeyEnv]])) })
      .filter(([, value]) => value !== undefined && value.trim() !== '')) as Record<string, string>
  }

  /** Persist a replacement shared model configuration without retaining any prior secret in memory. */
  async save(input: { apiKey: string; baseUrl?: string; providers?: Array<Omit<PublicProviderConfig, 'apiKeyConfigured'> & { apiKey: string }> }): Promise<GlobalModelConfig> {
    const oldValues = await this.read()
    const apiKey = input.apiKey.trim() || oldValues.DEEPSEEK_API_KEY?.trim() || ''
    if (/[\r\n]/u.test(apiKey)) throw new Error('API key must not contain line breaks')
    const baseUrl = input.baseUrl?.trim()
    if (baseUrl !== undefined && baseUrl !== '') new URL(baseUrl)
    const providers = (input.providers ?? []).map(provider => {
      const apiKey = provider.apiKey.trim() === '' ? oldValues[providerApiKeyEnv(provider.provider)] ?? '' : provider.apiKey.trim()
      validateProvider({ ...provider, apiKey })
      return { provider: provider.provider, ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }), api: provider.api, baseURL: provider.baseURL, models: provider.models, apiKeyEnv: providerApiKeyEnv(provider.provider) }
    }) as StoredProviderConfig[]
    if (apiKey === '' && providers.length === 0) throw new Error('API key or at least one provider is required')
    const providerKeys = providers.map(provider => `${provider.apiKeyEnv}=${encodeEnvValue((input.providers ?? []).find(item => item.provider === provider.provider)?.apiKey.trim() || oldValues[provider.apiKeyEnv] || '')}`)
    const providerConfig = Object.fromEntries(providers.map(({ provider, ...config }) => [provider, config]))
    const content = [`DEEPSEEK_API_KEY=${encodeEnvValue(apiKey)}`, ...(baseUrl === undefined || baseUrl === '' ? [] : [`DEEPSEEK_BASE_URL=${encodeEnvValue(baseUrl)}`]), `DSH_PUBLIC_LLM_PROVIDERS=${encodeEnvValue(JSON.stringify(providerConfig))}`, ...providerKeys, ''].join('\n')
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, content, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.path)
    return this.describe()
  }

  private async read(): Promise<Record<string, string>> {
    try { return parse(await readFile(this.path, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
}

function providerApiKeyEnv(provider: string): string { return `DSH_PUBLIC_LLM_KEY_${provider.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}` }

function encodeEnvValue(value: string): string { return value.replace(/\\/gu, '\\\\').replace(/\n/gu, '\\n') }

function decodeEnvValue(value: string): string { return value.replace(/\\n/gu, '\n').replace(/\\\\/gu, '\\') }

function parseProviders(value: string | undefined): StoredProviderConfig[] {
  if (value === undefined || value.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(value)
    const entries = Array.isArray(parsed) ? parsed.map(item => [typeof item === 'object' && item !== null ? (item as { provider?: unknown }).provider : undefined, item] as const) : typeof parsed === 'object' && parsed !== null ? Object.entries(parsed) : []
    return entries.flatMap(([key, item]) => {
      if (typeof item !== 'object' || item === null || typeof (item as { apiKeyEnv?: unknown }).apiKeyEnv !== 'string') return []
      const record = item as StoredProviderConfig
      const provider = typeof key === 'string' && !/^\d+$/u.test(key) ? key : record.provider
      return typeof provider === 'string' ? [{ ...record, provider }] : []
    })
  } catch { return [] }
}

function validateProvider(provider: Omit<PublicProviderConfig, 'apiKeyConfigured'> & { apiKey: string }): void {
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(provider.provider)) throw new Error('provider must be a lowercase hyphenated identifier')
  if (provider.displayName !== undefined && provider.displayName.trim() === '') throw new Error('provider display name is required when provided')
  if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(provider.api)) throw new Error('unsupported provider API')
  new URL(provider.baseURL)
  if (provider.apiKey.trim() === '') throw new Error('provider API key is required')
  if (provider.models.length === 0) throw new Error('provider must contain at least one model')
  for (const model of provider.models) {
    if (!/^[^\s]{1,200}$/u.test(model.id)) throw new Error('model id is invalid')
    if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow < 1)) throw new Error('model context window is invalid')
    if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens < 1)) throw new Error('model max tokens is invalid')
  }
}
