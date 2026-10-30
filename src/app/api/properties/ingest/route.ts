import { NextResponse } from 'next/server'
import { z } from 'zod'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { embedText } from '@/lib/agent/retrieval'

export const maxDuration = 60

const IngestChunk = z.object({
  chunk_type: z.string().min(1),
  content: z.string().min(1),
})

const IngestBody = z.object({
  property_id: z.string().min(1),
  chunks: z.array(IngestChunk).min(1),
})

/**
 * POST /api/properties/ingest
 *
 * Upsert property chunks + their embeddings into property_embeddings.
 * Admin+ only (Spec 6: properties are admin-managed); client_id is
 * derived from the resolved session context ONLY — never from the body
 * (multi-tenant isolation: a user can only write to their own client's
 * rows, mirroring the contacts import route).
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (error) {
    return toErrorResponse(error)
  }
  const supabase = ctx.supabase
  const clientId = ctx.accountId

  let body: z.infer<typeof IngestBody>
  try {
    body = IngestBody.parse(await request.json().catch(() => null))
  } catch {
    return NextResponse.json(
      { error: 'body must be { property_id, chunks: [{ chunk_type, content }] }' },
      { status: 400 },
    )
  }

  const results: Array<{ chunk_type: string; status: string; error?: string }> = []
  for (const chunk of body.chunks) {
    try {
      const embedding = await embedText(chunk.content)
      const { error } = await supabase
        .from('property_embeddings')
        .upsert(
          {
            client_id: clientId,
            property_id: body.property_id,
            chunk_type: chunk.chunk_type,
            content: chunk.content,
            embedding: embedding.reduce((acc, v) => {
              const n = parseFloat(v.toFixed(6))
              return acc ? `${acc},${n}` : `${n}`
            }, ''),
            metadata: {},
          },
          { onConflict: 'client_id,property_id,chunk_type' },
        )
      if (error) {
        console.error('[properties/ingest] upsert error:', error)
        results.push({ chunk_type: chunk.chunk_type, status: 'error', error: error.message })
      } else {
        results.push({ chunk_type: chunk.chunk_type, status: 'ok' })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'embedding failed'
      console.error('[properties/ingest] embedding error:', err)
      results.push({ chunk_type: chunk.chunk_type, status: 'error', error: message })
    }
  }

  const failed = results.filter((r) => r.status === 'error').length
  return NextResponse.json(
    {
      property_id: body.property_id,
      results,
      failed,
    },
    { status: failed > 0 ? 500 : 200 },
  )
}