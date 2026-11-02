/**
 * SAMPLE property fixture for the inbound smoke tests.
 *
 * NOT REAL INVENTORY. Every chunk is prefixed "SAMPLE DATA" so a human
 * reading the database (or a conversation) can never mistake it for a
 * real listing, and so the cleanup step can find it by property_id.
 *
 * Ingestion reuses `embedText` from src/lib/agent/retrieval — the same
 * lib function `/api/properties/ingest` calls — and writes the same row
 * shape that route writes (service-role client + upsert on
 * (client_id, property_id, chunk_type)). No app module is modified.
 */

import { supabaseAdmin } from '@/lib/supabase/admin';
import { embedText, retrievePropertyContext } from '@/lib/agent/retrieval';
import { toVectorLiteral } from '@/lib/pgvector';
import { SAMPLE_PROPERTY_ID } from './harness';

export { SAMPLE_PROPERTY_ID };

const PREFIX = 'SAMPLE DATA (test fixture, not real inventory) — ';

export interface SampleChunk {
  chunk_type: string;
  content: string;
}

export const SAMPLE_CHUNKS: SampleChunk[] = [
  {
    chunk_type: 'overview',
    content:
      PREFIX +
      'Marina Heights Tower 2, Dubai Marina. 2-bedroom apartment, 2 bathrooms, ' +
      '1,180 sqft, sea view, high floor. Availability: available, ready to ' +
      'move. Property reference rewa-sample-2br.',
  },
  {
    chunk_type: 'pricing',
    content:
      PREFIX +
      'Marina Heights Tower 2, 2-bedroom. Price: AED 1,850,000 total. Service ' +
      'charge: AED 14 per sqft per year. Dubai Land Department transfer fee 4%.',
  },
  {
    chunk_type: 'payment_plan',
    content:
      PREFIX +
      'Marina Heights Tower 2, 2-bedroom. Payment plan: 20% down payment on ' +
      'booking, 60% during construction in 4 instalments, 20% on handover in Q4 2027.',
  },
  {
    chunk_type: 'amenities',
    content:
      PREFIX +
      'Marina Heights Tower 2 amenities: infinity pool, gym, 24/7 concierge, ' +
      'covered parking, kids play area, 5 minutes walk to Marina Walk.',
  },
];

/** Figures the reply must contain once the fixture is ingested. */
export const SAMPLE_PRICE_FIGURES = [
  '1,850,000',
  '1850000',
  '1.85 million',
  '1.85m',
];
export const SAMPLE_PLAN_FIGURES = [
  '20%',
  '20 %',
  'sixty percent',
  '60%',
  '60 %',
];

export interface IngestOutcome {
  chunk_type: string;
  status: 'ok' | 'error';
  error?: string;
}

/**
 * Idempotent ingest of the SAMPLE property (upsert on
 * client_id,property_id,chunk_type — same conflict target as the route).
 *
 * Mirrors the route exactly: chunks are embedded with
 * `RETRIEVAL_DOCUMENT` and serialised through the shared pgvector
 * helper, so what this script writes is what `/api/properties/ingest`
 * writes.
 */
export async function ingestSampleProperty(
  clientId: string
): Promise<IngestOutcome[]> {
  const outcomes: IngestOutcome[] = [];

  for (const chunk of SAMPLE_CHUNKS) {
    try {
      const embedding = await embedText(chunk.content, 'RETRIEVAL_DOCUMENT');
      const { error } = await supabaseAdmin()
        .from('property_embeddings')
        .upsert(
          {
            client_id: clientId,
            property_id: SAMPLE_PROPERTY_ID,
            chunk_type: chunk.chunk_type,
            availability: 'available',
            content: chunk.content,
            embedding: toVectorLiteral(embedding),
            metadata: {
              sample: true,
              source: 'scripts/smoke-ingest-property.ts',
            },
          },
          { onConflict: 'client_id,property_id,chunk_type' }
        );
      if (error) {
        outcomes.push({
          chunk_type: chunk.chunk_type,
          status: 'error',
          error: truncate(error.message),
        });
      } else {
        outcomes.push({ chunk_type: chunk.chunk_type, status: 'ok' });
      }
    } catch (err) {
      outcomes.push({
        chunk_type: chunk.chunk_type,
        status: 'error',
        error: truncate(
          err instanceof Error ? err.message : 'embedding failed'
        ),
      });
    }
  }

  return outcomes;
}

function truncate(message: string, max = 180): string {
  return message.length > max ? `${message.slice(0, max)}…` : message;
}

export async function listSamplePropertyChunks(clientId: string) {
  const { data, error } = await supabaseAdmin()
    .from('property_embeddings')
    .select('id, chunk_type, content')
    .eq('client_id', clientId)
    .eq('property_id', SAMPLE_PROPERTY_ID)
    .order('chunk_type', { ascending: true });

  if (error)
    throw new Error(`property_embeddings lookup failed: ${error.message}`);
  return data ?? [];
}

/** How many property chunks this client has at all (any property). */
export async function countPropertyEmbeddings(
  clientId: string
): Promise<number> {
  const { count, error } = await supabaseAdmin()
    .from('property_embeddings')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId);

  if (error)
    throw new Error(`property_embeddings count failed: ${error.message}`);
  return count ?? 0;
}

export async function deleteSampleProperty(clientId: string): Promise<number> {
  const existing = await listSamplePropertyChunks(clientId);
  const { error } = await supabaseAdmin()
    .from('property_embeddings')
    .delete()
    .eq('client_id', clientId)
    .eq('property_id', SAMPLE_PROPERTY_ID);

  if (error)
    throw new Error(`property_embeddings delete failed: ${error.message}`);
  return existing.length;
}

/**
 * Read-only diagnostic: run the production retrieval path for a query
 * and report what the agent would actually see. Useful on its own (it
 * shows whether the SAMPLE chunks clear the configured similarity
 * threshold) and as evidence inside smoke-all step (c).
 *
 * Pass `similarityThreshold: 0` to see raw similarities even when
 * nothing clears the production threshold.
 */
export async function probeRetrieval(
  clientId: string,
  query: string,
  similarityThreshold?: number
) {
  return retrievePropertyContext({
    clientId,
    query,
    ...(similarityThreshold === undefined ? {} : { similarityThreshold }),
  });
}

// ============================================================
// Similarity calibration probe
//
// Embeds the 4 SAMPLE chunks with RETRIEVAL_DOCUMENT and a set of
// realistic questions with RETRIEVAL_QUERY, then scores every
// query x chunk pair with cosine similarity — the same metric
// pgvector's `<=>` operator uses (similarity = 1 - cosine distance).
// No database is involved, so the table isolates the embedding
// configuration from storage.
// ============================================================

export interface SimilarityProbeQuery {
  query: string;
  /** chunk_type the answer must be grounded in; null = off-topic. */
  relevantChunk: string | null;
}

/** 9 on-topic questions across the 4 fixtures + 2 irrelevant ones. */
export const SIMILARITY_PROBE_QUERIES: SimilarityProbeQuery[] = [
  { query: "What's the price of the 2BR?", relevantChunk: 'pricing' },
  {
    query: 'How much does the 2-bedroom apartment cost?',
    relevantChunk: 'pricing',
  },
  { query: "What's the payment plan?", relevantChunk: 'payment_plan' },
  {
    query: 'How much is the down payment on booking?',
    relevantChunk: 'payment_plan',
  },
  {
    query: 'What amenities does the building have?',
    relevantChunk: 'amenities',
  },
  {
    query: 'Is there a gym and an infinity pool?',
    relevantChunk: 'amenities',
  },
  { query: 'Where is the property located?', relevantChunk: 'overview' },
  {
    query: 'Can I book a viewing this weekend?',
    relevantChunk: 'overview',
  },
  { query: 'Tell me about the 2BR', relevantChunk: 'overview' },
  { query: "What's the weather in Dubai today?", relevantChunk: null },
  { query: 'Do you sell cars?', relevantChunk: null },
];

export interface SimilarityProbeRow {
  query: string;
  relevantChunk: string | null;
  /** chunk_type -> cosine similarity. */
  scores: Record<string, number>;
  bestChunk: string;
  bestScore: number;
}

export interface SimilarityProbeResult {
  chunkTypes: string[];
  rows: SimilarityProbeRow[];
}

export interface ThresholdEvaluation {
  /** Lowest score the relevant chunk reached across on-topic queries. */
  minOnTopicRelevant: number;
  /** Highest best-chunk score across off-topic queries. */
  maxOffTopicBest: number;
  /** Threshold that separates the two populations halfway. */
  recommended: number;
  rows: Array<{
    query: string;
    relevantChunk: string | null;
    retrieved: string | null;
    score: number;
    pass: boolean;
  }>;
  pass: boolean;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`embedding dimensions differ: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function probeSimilarityMatrix(): Promise<SimilarityProbeResult> {
  const chunkTypes = SAMPLE_CHUNKS.map((chunk) => chunk.chunk_type);
  const chunkEmbeddings: Array<{ chunkType: string; embedding: number[] }> =
    [];

  for (const chunk of SAMPLE_CHUNKS) {
    chunkEmbeddings.push({
      chunkType: chunk.chunk_type,
      embedding: await embedText(chunk.content, 'RETRIEVAL_DOCUMENT'),
    });
  }

  const rows: SimilarityProbeRow[] = [];
  for (const probe of SIMILARITY_PROBE_QUERIES) {
    const queryEmbedding = await embedText(probe.query, 'RETRIEVAL_QUERY');
    const scores: Record<string, number> = {};
    let bestChunk = chunkEmbeddings[0]?.chunkType ?? '';
    let bestScore = -1;
    for (const chunk of chunkEmbeddings) {
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      scores[chunk.chunkType] = score;
      if (score > bestScore) {
        bestScore = score;
        bestChunk = chunk.chunkType;
      }
    }
    rows.push({
      query: probe.query,
      relevantChunk: probe.relevantChunk,
      scores,
      bestChunk,
      bestScore,
    });
  }

  return { chunkTypes, rows };
}

export function formatSimilarityTable(
  result: SimilarityProbeResult,
  threshold?: number
): string {
  const chunkHeaders = result.chunkTypes.map((type) => type.padStart(14));
  const header =
    `${'query'.padEnd(46)} ${'expected'.padEnd(13)}` +
    ` ${chunkHeaders.join(' ')}   best`;
  const lines = [header, '-'.repeat(header.length)];

  for (const row of result.rows) {
    const expected = row.relevantChunk ?? '(off-topic)';
    const cells = result.chunkTypes.map((type) => {
      const score = row.scores[type] ?? 0;
      const value = score.toFixed(4);
      return (type === row.relevantChunk ? `${value}*` : value).padStart(14);
    });
    lines.push(
      `${row.query.slice(0, 46).padEnd(46)} ${expected.padEnd(13)} ` +
        `${cells.join(' ')}   ${row.bestChunk} ${row.bestScore.toFixed(4)}`
    );
  }

  if (threshold !== undefined) {
    lines.push('');
    lines.push(
      `threshold ${threshold.toFixed(2)} — * marks the expected chunk per query`
    );
  }
  return lines.join('\n');
}

/**
 * Score a threshold against the probe rows:
 *   on-topic  → the expected chunk must clear it;
 *   off-topic → no chunk may clear it.
 */
export function evaluateThreshold(
  result: SimilarityProbeResult,
  threshold: number
): ThresholdEvaluation {
  const onTopic = result.rows.filter((row) => row.relevantChunk !== null);
  const offTopic = result.rows.filter((row) => row.relevantChunk === null);

  const minOnTopicRelevant = Math.min(
    ...onTopic.map((row) => row.scores[row.relevantChunk as string] ?? 0)
  );
  const maxOffTopicBest =
    offTopic.length === 0
      ? 0
      : Math.max(...offTopic.map((row) => row.bestScore));

  const recommended =
    Math.round(((minOnTopicRelevant + maxOffTopicBest) / 2) * 100) / 100;

  const rows = result.rows.map((row) => {
    if (row.relevantChunk === null) {
      return {
        query: row.query,
        relevantChunk: null,
        retrieved: row.bestScore >= threshold ? row.bestChunk : null,
        score: row.bestScore,
        pass: row.bestScore < threshold,
      };
    }
    const score = row.scores[row.relevantChunk] ?? 0;
    return {
      query: row.query,
      relevantChunk: row.relevantChunk,
      retrieved: score >= threshold ? row.relevantChunk : null,
      score,
      pass: score >= threshold,
    };
  });

  return {
    minOnTopicRelevant,
    maxOffTopicBest,
    recommended,
    rows,
    pass: rows.every((row) => row.pass),
  };
}

