import { embed } from 'ai'
import { google } from '@ai-sdk/google'
import { openai } from '@ai-sdk/openai'
import { supabaseAdmin } from '@/lib/supabase/admin'
import type { Json } from '@/types/supabase'

// Matches property_embeddings.embedding vector(1536) (Spec 1). The
// embedding model is resolved once and shared by retrieval and the
// ingestion API so query and document vectors live in the same space.
const EMBEDDING_DIMENSIONS = 1536

export function getEmbeddingModel() {
  const provider = process.env.EMBEDDING_PROVIDER ?? process.env.AI_PROVIDER ?? 'google'
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
const DEFAULT_SIMILARITY_THRESHOLD = 0.75

/**
 * Embed a string with the shared embedding model. The document-side and
 * query-side calls must pass the same config so dimensions match.
 */
export async function embedText(value: string): Promise<number[]> {
  const { embedding } = await embed({
    model: getEmbeddingModel(),
    value,
    providerOptions: {
      google: {
        outputDimensionality: EMBEDDING_DIMENSIONS,
      },
    },
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
  const threshold = params.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD

  const queryEmbedding = await embedText(query)

  const { data, error } = await supabaseAdmin().rpc(
    'match_property_embeddings',
    {
      p_client_id: clientId,
      // pgvector text representation — PostgREST casts the JSON string
      // to the vector function argument.
      p_query_embedding: `[${queryEmbedding.join(',')}]`,
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