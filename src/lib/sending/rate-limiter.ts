/**
 * Per-phone-number send rate limiting.
 *
 * Meta limits the Cloud API to ~80 messages/second per phone number.
 * Every send path (campaign task, agent response, human reply) consumes
 * from the SAME token bucket keyed on `wa_phone_number_id`, so campaign +
 * agent + human traffic cannot unwittingly aggregate past the limit.
 *
 * This is an in-process token bucket. Trigger.dev may run tasks in
 * separate workers/processes; each process maintains its own bucket, and
 * a 15ms inter-send floor keeps any single process comfortably under
 * 80/s even if the bucket were bypassed.
 */

const RATE_PER_SECOND = 80;
const BURST = 80;
const MIN_SEND_INTERVAL_MS = 15;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until a send slot is available for this phone number, then consume
 * it. Returns once the caller may fire the request.
 */
export async function acquireSendSlot(phoneNumberId: string): Promise<void> {
  const now = Date.now();
  let bucket = buckets.get(phoneNumberId);
  if (!bucket) {
    bucket = { tokens: BURST, lastRefill: now };
    buckets.set(phoneNumberId, bucket);
  }

  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(BURST, bucket.tokens + elapsed * RATE_PER_SECOND);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return;
  }

  const secondsUntilToken = (1 - bucket.tokens) / RATE_PER_SECOND;
  const waitMs = Math.max(
    Math.ceil(secondsUntilToken * 1000),
    MIN_SEND_INTERVAL_MS
  );
  await sleep(waitMs);

  // Account for the elapsed wait, then consume the token we waited for.
  const afterWait = Date.now();
  bucket.tokens = Math.min(
    BURST,
    bucket.tokens + ((afterWait - bucket.lastRefill) / 1000) * RATE_PER_SECOND
  );
  bucket.lastRefill = afterWait;
  bucket.tokens -= 1;
}

/** Explicit pacing floor used between individual campaign sends. */
export { MIN_SEND_INTERVAL_MS };
