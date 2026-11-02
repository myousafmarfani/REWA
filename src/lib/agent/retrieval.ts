import { embed } from 'ai'
import { google } from '@ai-sdk/google'
import { openai } from '@ai-sdk/openai'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { toVectorLiteral } from '@/lib/pgvector'
import type { Json } from '@/types/supabase'

// Matches property_embeddings.embedding vector(1536) (Spec 1). The
// embedding model is resolved once and shared by retrieval and the
// ingestion API so query and document vectors live in the same space.
export const EMBEDDING_DIMENSIONS = 1536

/**
 * Gemini embeddings are asymmetric: documents and queries must be
 * embedded with the matching task type, otherwise the cosine scores
 * plateau below any usable threshold (measured 2026-10-31 — see
 * MEMORY.md entry 21).
 *
 * - RETRIEVAL_DOCUMENT: every property chunk written to pgvector
 *   (ingest route, sample-property scripts, any re-index job).
 * - RETRIEVAL_QUERY: the inbound question at retrieval time.
 */
export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'

function embeddingProvider(): 'google' | 'openai' | 'anthropic' {
  return (process.env.EMBEDDING_PROVIDER ??
    process.env.AI_PROVIDER ??
    'google') as 'google' | 'openai' | 'anthropic'
}

export function getEmbeddingModel() {
  const provider = embeddingProvider()
  const modelId = process.env.EMBEDDING_MODEL

  if (provider === 'openai' || provider === 'anthropic') {
    // text-embedding-3-small is 1536 dims natively.
    return openai.embedding(
      modelId || 'text-embedding-3-small',
    )
  }

  // Gemini embeddings default to 3072 dims — pin to 1536 via
  // providerOptions so values fit the vector(1536) column (Spec 1 A8).
  return google.embedding(
    modelId || 'gemini-embedding-001',
  )
}

export interface RetrievalResult {
  content: string
  chunkType: string
  metadata: Record<string, unknown>
  propertyId: string
  similarity: number
}

const DEFAULT_TOP_K = 5

/**
 * Chosen from measured data, not from the spec: the midpoint between
 * the lowest on-topic score for its expected chunk (0.6065) and the
 * highest best-chunk score for an off-topic query (0.5582). The best
 * off-topic score must stay below this and every on-topic query must
 * clear it. See MEMORY.md entry 21 and `scripts/probe-similarity.ts`.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.58

/**
 * `RETRIEVAL_SIMILARITY_THRESHOLD` overrides the measured default.
 * Invalid values fall back to the default rather than silently making
 * retrieval return everything (NaN comparison) or nothing.
 */
export function getSimilarityThreshold(): number {
  const raw = process.env.RETRIEVAL_SIMILARITY_THRESHOLD
  if (raw === undefined || raw.trim() === '') return DEFAULT_SIMILARITY_THRESHOLD
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    console.warn(
      '[agent:retrieval] ignoring invalid RETRIEVAL_SIMILARITY_THRESHOLD',
      { value: raw },
    )
    return DEFAULT_SIMILARITY_THRESHOLD
  }
  return parsed
}

/**
 * Embed a string with the shared embedding model.
 *
 * `taskType` is required so a document can never accidentally be
 * embedded as a query (or vice versa). Google receives both the task
 * type and the pinned output dimensionality through
 * `providerOptions.google` — the shape the installed @ai-sdk/google
 * provider forwards to `models/{id}:embedContent` / `batchEmbedContents`.
 * Other providers have no task-type concept, so they get no Google
 * provider options.
 */
export async function embedText(
  value: string,
  taskType: EmbeddingTaskType,
): Promise<number[]> {
  const isGoogle = embeddingProvider() === 'google'
  const { embedding } = await embed({
    model: getEmbeddingModel(),
    value,
    ...(isGoogle
      ? {
          providerOptions: {
            google: {
              outputDimensionality: EMBEDDING_DIMENSIONS,
              taskType,
            },
          },
        }
      : {}),
  })
  return embedding
}

/**
 * pgvector similarity search scoped to the client. Returns empty when
 * nothing is above threshold — the generate step handles empty retrieval
 * with a "will confirm and follow up" fallback, never a fabrication.
 */
export async function retrievePropertyContext(params: {
  clientId: string
  query: string
  topK?: number
  similarityThreshold?: number
}): Promise<RetrievalResult[]> {
  const { clientId, query } = params
  const topK = params.topK ?? DEFAULT_TOP_K
  const threshold = params.similarityThreshold ?? getSimilarityThreshold()

  const queryEmbedding = await embedText(query, 'RETRIEVAL_QUERY')

  const { data, error } = await supabaseAdmin().rpc(
    'match_property_embeddings',
    {
      p_client_id: clientId,
      // pgvector text representation (shared helper) — PostgREST casts
      // the JSON string to the vector function argument.
      p_query_embedding: toVectorLiteral(queryEmbedding),
      p_match_threshold: threshold,
      p_match_count: topK,
    },
  )

  if (error) {
    console.error('[agent:retrieval] pgvector search failed', {
      clientId,
      error: error.message,
    })
    return []
  }

  const rows = (data ?? []) as unknown as Array<{
    content: string
    chunk_type: string
    metadata: Json | null
    property_id: string
    similarity: number
  }>

  if (rows.length === 0) return []

  return rows.map((row) => ({
    content: row.content,
    chunkType: row.chunk_type,
    metadata: (row.metadata ?? {}) as unknown as Record<string, unknown>,
    propertyId: row.property_id,
    similarity: row.similarity,
  }))
}
