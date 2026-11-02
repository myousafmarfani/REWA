#!/usr/bin/env npx tsx
/**
 * Similarity-threshold calibration probe.
 *
 *   npx tsx scripts/probe-similarity.ts
 *
 * Embeds the 4 SAMPLE property chunks with taskType=RETRIEVAL_DOCUMENT
 * and every probe question with taskType=RETRIEVAL_QUERY, then scores
 * all query x chunk pairs with cosine similarity (pgvector's `<=>`
 * metric: similarity = 1 - cosine distance). No database and no dev
 * server needed — this isolates the embedding configuration.
 *
 * The script exits non-zero if the configured threshold
 * (RETRIEVAL_SIMILARITY_THRESHOLD, default chosen from this data) fails
 * to retrieve the expected chunk for an on-topic question, or fails to
 * reject an off-topic one.
 */

import './lib/env';

import { assertRepoRoot, section } from './lib/harness';
import {
  EMBEDDING_DIMENSIONS,
  getSimilarityThreshold,
} from '@/lib/agent/retrieval';
import {
  SIMILARITY_PROBE_QUERIES,
  evaluateThreshold,
  formatSimilarityTable,
  probeSimilarityMatrix,
} from './lib/sample-property';

async function main(): Promise<void> {
  assertRepoRoot();

  const threshold = getSimilarityThreshold();

  section('Embedding config');
  console.log(
    `  provider   : ${process.env.EMBEDDING_PROVIDER ?? process.env.AI_PROVIDER ?? 'google'}`
  );
  console.log(`  model      : ${process.env.EMBEDDING_MODEL ?? 'gemini-embedding-001'}`);
  console.log(`  dimensions : ${EMBEDDING_DIMENSIONS}`);
  console.log('  documents  : taskType=RETRIEVAL_DOCUMENT');
  console.log('  queries    : taskType=RETRIEVAL_QUERY');
  console.log(
    `  threshold  : ${threshold.toFixed(2)} ` +
      `(RETRIEVAL_SIMILARITY_THRESHOLD)`
  );
  console.log(
    `  queries    : ${SIMILARITY_PROBE_QUERIES.length} ` +
      `(${SIMILARITY_PROBE_QUERIES.filter((q) => q.relevantChunk).length} on-topic, ` +
      `${SIMILARITY_PROBE_QUERIES.filter((q) => !q.relevantChunk).length} off-topic)`
  );

  section('Embedding probe (cosine similarity)');
  const result = await probeSimilarityMatrix();
  console.log(formatSimilarityTable(result, threshold));

  section('Threshold evaluation');
  const evaluation = evaluateThreshold(result, threshold);
  console.log(
    `  lowest on-topic score for its expected chunk : ${evaluation.minOnTopicRelevant.toFixed(4)}`
  );
  console.log(
    `  highest best-chunk score for an off-topic query: ${evaluation.maxOffTopicBest.toFixed(4)}`
  );
  console.log(
    `  midpoint between the two populations         : ${evaluation.recommended.toFixed(2)}`
  );
  console.log(`  evaluated threshold                          : ${threshold.toFixed(2)}`);

  for (const row of evaluation.rows) {
    const label = row.relevantChunk ?? '(off-topic)';
    const detail =
      row.relevantChunk === null
        ? row.retrieved === null
          ? 'no match'
          : `LEAKED ${row.retrieved}`
        : row.retrieved === row.relevantChunk
          ? `retrieved ${row.retrieved}`
          : `MISSED ${row.relevantChunk}`;
    console.log(
      `  ${row.pass ? '✅' : '❌'} ${row.score.toFixed(4)}  ` +
        `${label.padEnd(13)} ${row.query}  → ${detail}`
    );
  }

  section('Result');
  if (evaluation.minOnTopicRelevant <= evaluation.maxOffTopicBest) {
    console.log(
      '❌ no separating threshold exists — on-topic and off-topic populations overlap'
    );
    process.exitCode = 1;
  } else if (!evaluation.pass) {
    console.log(
      `❌ threshold ${threshold.toFixed(2)} does not separate the populations ` +
        `(recommended ${evaluation.recommended.toFixed(2)})`
    );
    process.exitCode = 1;
  } else {
    console.log(
      `✅ threshold ${threshold.toFixed(2)} retrieves the expected chunk for all ` +
        `${SIMILARITY_PROBE_QUERIES.filter((q) => q.relevantChunk).length} on-topic ` +
        `queries and returns nothing for both off-topic queries`
    );
  }
}

main().catch((error) => {
  console.error('\n💥 probe-similarity crashed:', error);
  process.exitCode = 1;
});
