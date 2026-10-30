-- ============================================================
-- Spec 3: Autonomous Agent Core — DB support
--
-- 1. match_property_embeddings RPC  (pgvector similarity search)
-- 2. Unique index on messages (client_id, wa_message_id) for
--    idempotent inbound persistence (webhook replays / Meta retries).
--    Plain (not partial) so PostgREST ON CONFLICT inference works.
-- 3. Unique index on property_embeddings (client_id, property_id,
--    chunk_type) so the ingest API upserts deterministically.
-- ============================================================

-- ---------------------------------------------------------------------------
-- pgvector similarity search.
--
-- SECURITY INVOKER (not DEFINER): the agent layer runs with the
-- service-role client which bypasses RLS anyway, but authenticated
-- callers must still be constrained by property_embeddings RLS. The
-- p_client_id parameter is the multi-tenant scope for service-role
-- callers; RLS is the scope for session callers.
-- ---------------------------------------------------------------------------
create or replace function match_property_embeddings(
  p_client_id uuid,
  p_query_embedding vector,
  p_match_threshold double precision,
  p_match_count int
)
returns table (
  property_id text,
  chunk_type text,
  content text,
  metadata jsonb,
  similarity double precision
)
language sql
stable
set search_path = public
as $$
  select
    pe.property_id,
    pe.chunk_type,
    pe.content,
    pe.metadata,
    1 - (pe.embedding <=> p_query_embedding) as similarity
  from property_embeddings pe
  where pe.client_id = p_client_id
    and pe.embedding is not null
    and 1 - (pe.embedding <=> p_query_embedding) > p_match_threshold
    -- Sold/withdrawn units must never surface as active inventory
    -- (MEMORY entry 8: every property fact must be accurate).
    and pe.availability not in ('sold', 'reserved')
  order by pe.embedding <=> p_query_embedding
  limit p_match_count
$$;

revoke all on function match_property_embeddings(uuid, vector, double precision, int) from public;
grant execute on function match_property_embeddings(uuid, vector, double precision, int) to authenticated;
grant execute on function match_property_embeddings(uuid, vector, double precision, int) to service_role;

-- ---------------------------------------------------------------------------
-- Idempotent inbound inserts.
--
-- PostgREST upsert() with onConflict inference requires a plain unique
-- index over exactly the referenced columns (partial indexes break ON
-- CONFLICT inference). wa_message_id is nullable; Postgres treats NULLs
-- as distinct in a unique index, so outbound rows without a WA id are
-- unaffected.
-- ---------------------------------------------------------------------------
create unique index if not exists messages_client_id_wa_message_id_key
  on messages (client_id, wa_message_id);

-- ---------------------------------------------------------------------------
-- Deterministic ingest upsert target for /api/properties/ingest.
-- ---------------------------------------------------------------------------
create unique index if not exists property_embeddings_client_id_property_id_chunk_type_key
  on property_embeddings (client_id, property_id, chunk_type);