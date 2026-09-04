import { decodeProtectedHeader, jwtVerify } from 'jose'

/** Verified identity extracted from a single-use SSO sign-in token. */
export interface SsoIdentity {
  issuer: string
  subject: string
  username: string
  displayName: string
  tokenId: string
  expiresAt: number
}

export interface SsoVerifierOptions {
  issuer: string
  audience: string
  keys: ReadonlyMap<string, CryptoKey>
  allowedOrigin: string
  now?: () => number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const CLOCK_TOLERANCE_SECONDS = 5
const MAX_TOKEN_LIFETIME_SECONDS = 60
const MAX_TOKEN_AGE_SECONDS = 70

/** Verify fixed SSO sign-in tokens and consume their single-use ids. */
export class SsoVerifier {
  readonly allowedOrigin: string
  private readonly consumed = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly options: SsoVerifierOptions) {
    if (options.keys.size === 0) throw new Error('at least one SSO public key is required')
    const origin = new URL(options.allowedOrigin)
    if ((origin.protocol !== 'http:' && origin.protocol !== 'https:') || origin.pathname !== '/' || origin.search !== '' || origin.hash !== '' || origin.username !== '' || origin.password !== '') throw new Error('SSO origin must be an HTTP(S) origin without path or credentials')
    this.allowedOrigin = origin.origin
    this.now = options.now ?? Date.now
  }

  /** Verify one compact JWS without exposing unverified claims to callers. */
  async verify(token: string): Promise<SsoIdentity> {
    try {
      const header = decodeProtectedHeader(token)
      if (header.alg !== 'EdDSA' || header.typ !== 'JWT' || typeof header.kid !== 'string') throw new Error('invalid token header')
      const key = this.options.keys.get(header.kid)
      if (key === undefined) throw new Error('unknown signing key')
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['EdDSA'], issuer: this.options.issuer, audience: this.options.audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS, currentDate: new Date(this.now()),
      })
      if (payload.role !== undefined || payload.roles !== undefined || payload.admin !== undefined || payload.is_admin !== undefined || payload.isAdmin !== undefined || payload.administrator !== undefined || payload.permissions !== undefined) throw new Error('privileged claims are not accepted')
      const { iss, sub, preferred_username: username, name: displayName, jti, iat, nbf, exp } = payload
      if (typeof iss !== 'string' || typeof sub !== 'string' || typeof username !== 'string' || typeof displayName !== 'string' || typeof jti !== 'string') throw new Error('required token claims are missing')
      if (!UUID.test(sub) || !UUID.test(jti) || username.trim() === '' || [...username].length > 64 || displayName.trim() === '' || [...displayName].length > 120) throw new Error('token claims are invalid')
      if (typeof iat !== 'number' || typeof nbf !== 'number' || typeof exp !== 'number' || !Number.isSafeInteger(iat) || !Number.isSafeInteger(nbf) || !Number.isSafeInteger(exp) || nbf !== iat || exp <= iat || exp - iat > MAX_TOKEN_LIFETIME_SECONDS) throw new Error('token time claims are invalid')
      const current = Math.floor(this.now() / 1000)
      if (iat > current + CLOCK_TOLERANCE_SECONDS || nbf > current + CLOCK_TOLERANCE_SECONDS || exp < current - CLOCK_TOLERANCE_SECONDS || current - iat > MAX_TOKEN_AGE_SECONDS) throw new Error('token time window is invalid')
      return { issuer: iss, subject: sub, username: username.trim(), displayName: displayName.trim(), tokenId: jti, expiresAt: exp * 1000 }
    } catch {
      throw new Error('invalid or expired sign-in token')
    }
  }

  /** Atomically consume a JTI until its verified expiry time. */
  consume(tokenId: string, expiresAt: number): boolean {
    const now = this.now()
    for (const [id, expiry] of this.consumed) if (expiry <= now) this.consumed.delete(id)
    if (this.consumed.has(tokenId) || expiresAt <= now) return false
    this.consumed.set(tokenId, expiresAt)
    return true
  }
}
