import { describe, expect, it } from 'vitest'

import { toVectorLiteral } from './pgvector'

describe('toVectorLiteral', () => {
  it('wraps the values in pgvector brackets', () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]')
  })

  it('never emits the bare comma form rejected by Postgres', () => {
    const literal = toVectorLiteral([0.003363, -0.00689, 0])
    expect(literal).toBe('[0.003363,-0.00689,0]')
    expect(literal).not.toBe('0.003363,-0.00689,0')
    expect(literal.startsWith('[')).toBe(true)
    expect(literal.endsWith(']')).toBe(true)
  })
})
