/**
 * Sending-spec types: the error taxonomy and the Meta error-code maps
 * that decide whether a failed send is retryable, a blocked recipient
 * (→ opted_out), or an invalid number (→ contacts.status='invalid').
 *
 * Deterministic errors are separated from transient ones so the
 * Trigger.dev tasks can abort instead of burning backoff retries on a
 * state that will never change (opted_out, closed window, missing
 * credentials, unapproved template).
 */

export type MessageType = 'agent_response' | 'human_reply' | 'campaign';

export type SendKind = 'text' | 'template';

/** Notification channel used by sendMessageTask. */
export interface SendResult {
  waMessageId: string;
}

// ---------------------------------------------------------------------------
// Meta Cloud API error-code families (Graph API error.error.code).
//
// 131026 Message Undeliverable            → recipient not reachable
// 131047 Recipient phone is not mobile    → invalid number
// 131048 Recipient has no WhatsApp        → invalid number
// 131049 Recipient opted out              → genuine opt-out / block
// 131051 Recipient is an "unavailable"    → invalid number
// 131040 / 131043 Session expired         → free-form outside 24h window
// ---------------------------------------------------------------------------

/** Codes meaning the recipient has effectively opted out / blocked us. */
const BLOCKED_CODES = new Set([131026, 131049]);

/** Codes meaning the number itself is undeliverable — not an opt-out. */
const INVALID_NUMBER_CODES = new Set([131047, 131048, 131051]);

/** Codes signalling a free-form message was attempted outside the window. */
const WINDOW_VIOLATION_CODES = new Set([131040, 131043]);

export function isBlockedContactCode(code: number | null | undefined): boolean {
  return typeof code === 'number' && BLOCKED_CODES.has(code);
}

export function isInvalidNumberCode(code: number | null | undefined): boolean {
  return typeof code === 'number' && INVALID_NUMBER_CODES.has(code);
}

export function isWindowViolationCode(
  code: number | null | undefined
): boolean {
  return typeof code === 'number' && WINDOW_VIOLATION_CODES.has(code);
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * Base class for errors that must NOT be retried by Trigger.dev — the
 * underlying state (opted out, closed window, config) is deterministic.
 * Task definitions throw {@link AbortTaskRunError} when one of these
 * surfaces so backoff retries are not wasted.
 */
export class DeterministicSendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeterministicSendingError';
  }
}

/** Free-form text attempted outside the open 24-hour window. */
export class ComplianceError extends DeterministicSendingError {
  constructor(message: string) {
    super(message);
    this.name = 'ComplianceError';
  }
}

/** Contact is opted out — the hard gate (MEMORY entry 8). */
export class OptedOutError extends DeterministicSendingError {
  constructor(message: string) {
    super(message);
    this.name = 'OptedOutError';
  }
}

/** client_config lacks wa_phone_number_id / wa_access_token, or the
 *  stored token cannot be decrypted. */
export class SendingNotConfiguredError extends DeterministicSendingError {
  constructor(message: string) {
    super(message);
    this.name = 'SendingNotConfiguredError';
  }
}

/** Campaign references a template that is not Meta-approved. */
export class TemplateNotApprovedError extends DeterministicSendingError {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateNotApprovedError';
  }
}

/** Optional per-template context the orchestrator needs for campaign sends. */
export interface TemplateSendSpec {
  /** Meta template name (message_templates.name). */
  name: string;
  /** Meta language code, e.g. 'en_US'. Passed through to the API. */
  language: string;
  /** Component values (template). For campaign sends this is the
   *  body variables rendered from campaign_contacts.params. */
  components?: unknown[];
}

/**
 * A failed HTTP call to the WhatsApp Cloud API (or a network failure
 * reaching it). Transient by nature: `retryable` is true for network
 * errors and HTTP 408/425/429/5xx. Any other outcome (4xx business
 * error) is permanent and must not be retried inside the campaign loop.
 */
export class WaSendError extends Error {
  readonly waErrorCode: number | null;
  readonly httpStatus: number | null;
  readonly recipient: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: {
      waErrorCode?: number | null;
      httpStatus?: number | null;
      recipient: string;
      retryable?: boolean;
    }
  ) {
    super(message);
    this.name = 'WaSendError';
    this.waErrorCode = opts.waErrorCode ?? null;
    this.httpStatus = opts.httpStatus ?? null;
    this.recipient = opts.recipient;
    this.retryable = opts.retryable ?? false;
  }

  /** True when this error means the recipient has blocked / opted out. */
  get isBlockedContact(): boolean {
    return isBlockedContactCode(this.waErrorCode);
  }

  /** True when this error means the number is invalid, not an opt-out. */
  get isInvalidNumber(): boolean {
    return isInvalidNumberCode(this.waErrorCode);
  }

  get isWindowViolation(): boolean {
    return isWindowViolationCode(this.waErrorCode);
  }
}

/** HTTP statuses worth retrying (network-flaky / throttled / 5xx). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableHttpStatus(
  status: number | null | undefined
): boolean {
  return typeof status === 'number' && RETRYABLE_STATUS.has(status);
}
