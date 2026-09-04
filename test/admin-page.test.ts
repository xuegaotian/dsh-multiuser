import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { adminPageHtml } from '../src/admin-page.js'

describe('adminPageHtml', () => {
  it('renders syntactically valid browser JavaScript', () => {
    const match = /<script>([\s\S]*)<\/script>/u.exec(adminPageHtml())
    expect(match?.[1]).toBeDefined()
    expect(() => new Script(match![1]!)).not.toThrow()
    expect(match![1]).toContain('const result = await response')
    expect(adminPageHtml()).toContain('id="open-skill"')
    expect(adminPageHtml()).toContain('id="open-plugin"')
    expect(adminPageHtml()).toContain('id="open-mcp"')
    expect(adminPageHtml()).toContain('id="mcp-transport"')
    expect(match![1]).toContain("item.projections?.asOfSeq")
    expect(match![1]).toContain("readSessions(userId,'history',{sessionId,throughSeq,maxMessages:100})")
    expect(match![1]).toContain("data?.result?.ok===false")
    expect(match![1]).toContain("fetch('/admin/public-mcp'")
    expect(match![1]).toContain('function toggleMcpTransport()')
  })
})
