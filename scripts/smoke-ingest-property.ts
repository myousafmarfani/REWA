#!/usr/bin/env npx tsx
/**
 * Ingest one SAMPLE property for the dev client.
 *
 *   npx tsx scripts/smoke-ingest-property.ts
 *   npx tsx scripts/smoke-ingest-property.ts --clear
 *
 * Uses the same lib function the /api/properties/ingest route uses
 * (`embedText` from src/lib/agent/retrieval) and the same row shape /
 * conflict target (client_id, property_id, chunk_type), but with the
 * service-role client so no dashboard session is needed.
 *
 * The fixture is clearly labelled SAMPLE DATA and lives under
 * property_id = 'rewa-sample-2br'; `--clear` removes it, and
 * smoke-all.ts removes it during cleanup.
 */

import './lib/env';

import {
  assertCoreEnv,
  assertRepoRoot,
  resolveDevClient,
  section,
} from './lib/harness';
import {
  SAMPLE_CHUNKS,
  SAMPLE_PROPERTY_ID,
  deleteSampleProperty,
  evaluateThreshold,
  formatSimilarityTable,
  ingestSampleProperty,
  listSamplePropertyChunks,
  probeRetrieval,
  probeSimilarityMatrix,
} from './lib/sample-property';
import { getSimilarityThreshold } from '@/lib/agent/retrieval';

const PROBE_QUERY = "What's the price and payment plan for the 2BR?";

async function main(): Promise<void> {
  assertRepoRoot();
  assertCoreEnv();

  const clearOnly = process.argv.slice(2).includes('--clear');
  const client = await resolveDevClient();

  section('Client');
  console.log(`  ${client.name} (${client.id})`);

  if (clearOnly) {
    const removed = await deleteSampleProperty(client.id);
    console.log(
      `\n🧹 removed ${removed} SAMPLE property chunk(s) ` +
        `(property_id=${SAMPLE_PROPERTY_ID})`
    );
    return;
  }

  section('Ingesting SAMPLE property');
  console.log(`  property_id: ${SAMPLE_PROPERTY_ID}`);
  console.log(
    `  chunks     : ${SAMPLE_CHUNKS.map((c) => c.chunk_type).join(', ')}`
  );

  const outcomes = await ingestSampleProperty(client.id);
  for (const outcome of outcomes) {
    console.log(
      `  ${outcome.status === 'ok' ? '✅' : '❌'} ${outcome.chunk_type.padEnd(14)}` +
        (outcome.error ? `  ${outcome.error}` : '')
    );
  }

  const stored = await listSamplePropertyChunks(client.id);
  section('Stored rows');
  for (const row of stored) {
    console.log(`  ${row.chunk_type.padEnd(14)} ${row.content.slice(0, 80)}…`);
  }
  console.log(`  total: ${stored.length}`);

  const threshold = getSimilarityThreshold();

  // Read-only diagnostic. The agent only sees what clears the configured
  // threshold (RETRIEVAL_SIMILARITY_THRESHOLD, default calibrated from
  // scripts/probe-similarity.ts).
  section('Retrieval probe (production path)');
  console.log(`  query: ${JSON.stringify(PROBE_QUERY)}`);
  console.log(`  threshold: ${threshold.toFixed(2)}`);
  try {
    const hits = await probeRetrieval(client.id, PROBE_QUERY);
    if (!hits.length) {
      console.log(
        `  ⚠ 0 chunks cleared the ${threshold.toFixed(2)} similarity threshold — the agent will ` +
          'answer "I will confirm" even though the data exists.'
      );
      const raw = await probeRetrieval(client.id, PROBE_QUERY, 0);
      for (const hit of raw) {
        console.log(
          `  below threshold: ${hit.similarity.toFixed(4)}  ${hit.chunkType.padEnd(14)}`
        );
      }
      if (raw.length) {
        console.log(
          `  best similarity ${raw[0].similarity.toFixed(4)} < ${threshold.toFixed(2)} — ` +
            'retrieval cannot ground an answer with this embedding config.'
        );
      }
    } else {
      for (const hit of hits) {
        console.log(
          `  ${hit.similarity.toFixed(4)}  ${hit.chunkType.padEnd(14)} ${hit.content.slice(0, 60)}…`
        );
      }
    }
  } catch (error) {
    console.log(
      `  ⚠ retrieval probe failed: ${error instanceof Error ? error.message : error}`
    );
  }

  // Full query x chunk matrix, embedded independently of the database:
  // chunks with RETRIEVAL_DOCUMENT, questions with RETRIEVAL_QUERY.
  section('Similarity matrix (documents vs queries)');
  const matrix = await probeSimilarityMatrix();
  console.log(formatSimilarityTable(matrix, threshold));
  const evaluation = evaluateThreshold(matrix, threshold);
  console.log(
    `  lowest on-topic score ${evaluation.minOnTopicRelevant.toFixed(4)} / ` +
      `highest off-topic best ${evaluation.maxOffTopicBest.toFixed(4)} / ` +
      `midpoint ${evaluation.recommended.toFixed(2)}`
  );
  if (!evaluation.pass) {
    console.log(
      `  ❌ threshold ${threshold.toFixed(2)} does not separate on-topic from off-topic queries`
    );
    process.exitCode = 1;
  } else {
    console.log(`  ✅ threshold ${threshold.toFixed(2)} separates both populations`);
  }

  const failed = outcomes.filter((o) => o.status !== 'ok');
  section('Result');
  if (failed.length) {
    console.log(`❌ ingest FAILED for ${failed.length} chunk(s)`);
    process.exitCode = 1;
  } else {
    console.log(
      `✅ ingested ${outcomes.length} SAMPLE chunk(s). ` +
        'Run `npx tsx scripts/smoke-inbound.ts "What\'s the price and payment plan for the 2BR?"` to exercise the agent.'
    );
  }
}

main().catch((error) => {
  console.error('\n💥 smoke-ingest-property crashed:', error);
  process.exitCode = 1;
});
