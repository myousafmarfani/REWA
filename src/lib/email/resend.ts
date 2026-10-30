import { Resend } from 'resend';

/**
 * Shared platform-email client (spec 5 — MEMORY entry 10: escalation
 * mail goes from the PLATFORM's configured sender, never an agent's
 * personal address).
 *
 * Everything alert-shaped routes through here: hot-lead escalation
 * (escalation.ts), RED quality-rating alerts (trigger/quality-monitor),
 * and the daily export link (trigger/export-contacts).
 *
 * Behaviour contract:
 *  - Lazy singleton — importing this module never touches the network,
 *    so route/test code can load it unconditionally.
 *  - Missing RESEND_API_KEY degrades to a logged no-op (dev + CI run
 *    without a Resend account; MEMORY entry 17 keeps build cost $0).
 *  - sendEmail NEVER throws — callers are background jobs and agent
 *    steps where a failed alert must not fail the surrounding flow.
 */

let client: Resend | null = null;
let clientResolved = false;

function getClient(): Resend | null {
  if (!clientResolved) {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    client = apiKey ? new Resend(apiKey) : null;
    clientResolved = true;
  }
  return client;
}

/** Test seam — lets unit tests assert call shapes without a live key. */
export function __resetEmailClientForTests(): void {
  client = null;
  clientResolved = false;
}

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  /** Defaults to RESEND_FROM_EMAIL. */
  from?: string;
  /** Log tag so alerts are traceable in job output. */
  source?: string;
}

/**
 * Send one platform email. Returns true only on provider acceptance.
 * Failures are logged and swallowed — alert delivery is best-effort.
 */
export async function sendEmail(params: SendEmailParams): Promise<boolean> {
  const from = params.from ?? process.env.RESEND_FROM_EMAIL?.trim();
  if (!from) {
    console.warn('[email] RESEND_FROM_EMAIL not configured — skipping send', {
      source: params.source ?? 'unknown',
      to: params.to,
    });
    return false;
  }

  const resend = getClient();
  if (!resend) {
    console.warn('[email] RESEND_API_KEY not configured — skipping send', {
      source: params.source ?? 'unknown',
      to: params.to,
    });
    return false;
  }

  try {
    const { data, error } = await resend.emails.send({
      from,
      to: params.to,
      // Subjects interpolate contact/brand names — collapse all
      // whitespace so a stray newline in a DB value cannot smuggle
      // extra header lines through the JSON API.
      subject: params.subject.replace(/\s+/g, ' ').trim(),
      html: params.html,
    });
    if (error) {
      console.error('[email] send failed', {
        source: params.source ?? 'unknown',
        to: params.to,
        error: error.message,
      });
      return false;
    }
    return Boolean(data?.id);
  } catch (error) {
    console.error('[email] send threw', {
      source: params.source ?? 'unknown',
      to: params.to,
      error: error instanceof Error ? error.message : error,
    });
    return false;
  }
}

/**
 * Escape untrusted text (contact names, message bodies) before it goes
 * into an HTML email. Alert bodies are built from contact-controlled
 * content — without this a message body could inject markup into the
 * agent's inbox.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
