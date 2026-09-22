import { generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { SsoVerifier } from '../src/sso.js'

let privateKey: CryptoKey
let publicKey: CryptoKey
let verifier: SsoVerifier
const now = 1_700_000_000_000

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA')
  privateKey = pair.privateKey
  publicKey = pair.publicKey
  verifier = new SsoVerifier({ issuer: 'example-idp', audience: 'dsh-multiuser', allowedOrigin: 'https://sso.example.com', keys: new Map([['sso-2026-01', publicKey]]), now: () => now })
})

async function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
  const seconds = now / 1000
  return new SignJWT({ sub: '11111111-1111-4111-8111-111111111111', preferred_username: 'zhangsan', name: 'Zhang San', jti: '22222222-2222-4222-8222-222222222222', ...claims })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: 'sso-2026-01', ...header })
    .setIssuer('example-idp').setAudience('dsh-multiuser').setIssuedAt(seconds).setNotBefore(seconds).setExpirationTime(seconds + 60).sign(privateKey)
}

describe('SsoVerifier', () => {
  it('verifies a fixed EdDSA token and consumes its jti once', async () => {
    const identity = await verifier.verify(await token())
    expect(identity).toMatchObject({ subject: '11111111-1111-4111-8111-111111111111', username: 'zhangsan', tokenId: '22222222-2222-4222-8222-222222222222' })
    expect(verifier.consume(identity.tokenId, identity.expiresAt)).toBe(true)
    expect(verifier.consume(identity.tokenId, identity.expiresAt)).toBe(false)
  })

  it('rejects unknown kid, privileged claims, and malformed identity claims', async () => {
    await expect(verifier.verify(await token({}, { kid: 'unknown' }))).rejects.toThrow('invalid or expired sign-in token')
    await expect(verifier.verify(await token({ role: 'admin' }))).rejects.toThrow('invalid or expired sign-in token')
    await expect(verifier.verify(await token({ sub: 'not-a-uuid' }))).rejects.toThrow('invalid or expired sign-in token')
  })

  it('accepts an HTTP origin but rejects non-HTTP schemes', () => {
    const keys = new Map([['sso-2026-01', publicKey]])
    expect(() => new SsoVerifier({ issuer: 'example-idp', audience: 'dsh-multiuser', allowedOrigin: 'http://127.0.0.1:8000', keys })).not.toThrow()
    expect(() => new SsoVerifier({ issuer: 'example-idp', audience: 'dsh-multiuser', allowedOrigin: 'file:///tmp/sso', keys })).toThrow('HTTP(S) origin')
  })
})
