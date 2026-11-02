/**
 * Env bootstrap for the smoke scripts.
 *
 * MUST be the first import of every entry script: `src/lib/whatsapp/
 * encryption.ts` binds ENCRYPTION_KEY at module-evaluation time, so the
 * environment has to be loaded before any app module is evaluated.
 *
 * Uses Next's own env loader (the same one `next dev` uses) so the smoke
 * scripts see exactly the same values as the running app: .env.local
 * wins over .env, and .env.development/.env.development.local are
 * applied for the dev phase.
 */

import { loadEnvConfig } from '@next/env';

// Capture before loadEnvConfig — it may set NODE_ENV to 'development'.
const ENV_BEFORE_LOAD = process.env.NODE_ENV;

loadEnvConfig(process.cwd(), true, {
  info: () => {},
  error: (msg) => console.error(msg),
});

export const RAW_NODE_ENV = ENV_BEFORE_LOAD;

/**
 * True when the operator explicitly ran with NODE_ENV=production. The
 * scripts write fake credentials and delete test rows, so that is
 * refused. (@next/env may normalise NODE_ENV after this, hence the
 * captured value above.)
 */
export function isProduction(): boolean {
  return ENV_BEFORE_LOAD === 'production';
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Missing required env var ${name}. The smoke scripts load .env.local ` +
        `from the repo root — run them from the repo root.`
    );
  }
  return value;
}

/** Fail fast, with a readable message, when a core env var is absent. */
export function assertCoreEnv(): void {
  for (const name of [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ENCRYPTION_KEY',
  ]) {
    requireEnv(name);
  }
}
