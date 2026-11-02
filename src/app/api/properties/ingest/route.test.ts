import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(),
  toErrorResponse: vi.fn(
    () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
  ),
}))

vi.mock('@/lib/agent/retrieval', () => ({
  embedText: vi.fn(),
}))

import { requireRole } from '@/lib/auth/account'
import { embedText } from '@/lib/agent/retrieval'
import { POST } from './route'

const mockedRequireRole = vi.mocked(requireRole)
const mockedEmbedText = vi.mocked(embedText)

interface UpsertCall {
  payload: Record<string, unknown>
  options: Record<string, unknown>
}

function makeSupabaseMock() {
  const upserts: UpsertCall[] = []
  const from = vi.fn(() => ({
    upsert: vi.fn(async (payload: Record<string, unknown>, options: Record<string, unknown>) => {
      upserts.push({ payload, options })
      return { error: null }
    }),
  }))
  return { supabase: { from }, upserts }
}

function ingestRequest(body: unknown): Request {
  return new Request('http://localhost/api/properties/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mockedEmbedText.mockResolvedValue([0.1, 0.2, 0.3])
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/properties/ingest', () => {
  it('writes the embedding as a bracketed pgvector literal', async () => {
    const { supabase, upserts } = makeSupabaseMock()
    mockedRequireRole.mockResolvedValue({
      supabase,
      accountId: 'client-1',
    } as unknown as Awaited<ReturnType<typeof requireRole>>)

    const res = await POST(
      ingestRequest({
        property_id: 'property-1',
        chunks: [{ chunk_type: 'pricing', content: 'Price: AED 1,850,000' }],
      }),
    )

    expect(res.status).toBe(200)
    expect(upserts).toHaveLength(1)
    // Regression: the old route emitted "0.1,0.2,0.3", which Postgres
    // rejects with `invalid input syntax for type vector`.
    expect(upserts[0].payload.embedding).toBe('[0.1,0.2,0.3]')
    expect(upserts[0].payload.embedding).not.toBe('0.1,0.2,0.3')
    expect(upserts[0].options).toEqual({
      onConflict: 'client_id,property_id,chunk_type',
    })
  })

  it('embeds stored chunks with the RETRIEVAL_DOCUMENT task type', async () => {
    const { supabase } = makeSupabaseMock()
    mockedRequireRole.mockResolvedValue({
      supabase,
      accountId: 'client-1',
    } as unknown as Awaited<ReturnType<typeof requireRole>>)

    await POST(
      ingestRequest({
        property_id: 'property-1',
        chunks: [{ chunk_type: 'overview', content: 'Marina Heights Tower 2' }],
      }),
    )

    expect(mockedEmbedText).toHaveBeenCalledWith(
      'Marina Heights Tower 2',
      'RETRIEVAL_DOCUMENT',
    )
  })
})
