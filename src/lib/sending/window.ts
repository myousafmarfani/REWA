import { ComplianceError, type SendKind } from './types';

/**
 * 24-hour customer service window (outreach-compliance skill).
 *
 * The window opens with the contact's LAST inbound message and resets on
 * every new inbound message. `contacts.wa_window_open` does NOT exist —
 * Spec 1 amendment A5 removed the persisted boolean and the window is
 * always derived on read from `contacts.last_inbound_at`
 * (single writer = the inbound webhook handler, never the sending layer).
 * Within the window any message type may be sent (free). Outside it only
 * pre-approved Meta templates may initiate contact (paid).
 */

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export function toTimestamp(raw: string | Date | null): number | null {
  if (raw === null || raw === undefined) return null;
  const t = typeof raw === 'string' ? new Date(raw).getTime() : raw.getTime();
  return Number.isNaN(t) ? null : t;
}

export function isWindowOpen(lastInboundAt: string | Date | null): boolean {
  const t = toTimestamp(lastInboundAt);
  if (t === null) return false;
  return Date.now() - t < WINDOW_MS;
}

/**
 * Hard invariant checked at every text-send call site. Free-form text
 * outside the open window is the single most dangerous compliance
 * violation in the product (risk of number restriction), so it throws
 * rather than silently rerouting. Template sends are always permissible
 * regardless of window state.
 */
export function assertWindowOpen(
  lastInboundAt: string | Date | null,
  kind: SendKind
): void {
  if (kind === 'text' && !isWindowOpen(lastInboundAt)) {
    throw new ComplianceError(
      'COMPLIANCE: Attempted to send free-form text outside the 24-hour ' +
        'window (last_inbound_at absent or older than 24h). Only approved ' +
        'template messages may initiate contact outside the window.'
    );
  }
}
