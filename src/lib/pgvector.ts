/**
 * pgvector text serialisation — the single helper for every vector that
 * crosses the PostgREST boundary.
 *
 * Postgres parses a `vector` literal as `[0.1,0.2,...]`. A bare
 * `0.1,0.2,...` string is rejected with `invalid input syntax for type
 * vector`, and a raw JS array does not cast reliably through PostgREST.
 * Stored vectors (property ingest) and query vectors (retrieval RPC)
 * must therefore be produced by the same function, so they cannot drift
 * apart again.
 */
export function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}
