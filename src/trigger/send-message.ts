import { AbortTaskRunError, task } from '@trigger.dev/sdk/v3';
import { sendWhatsAppMessage } from '@/lib/sending';
import {
  DeterministicSendingError,
  WaSendError,
  type MessageType,
} from '@/lib/sending/types';

/**
 * send-message — one outbound WhatsApp message triggered for a single
 * recipient (human reply from the dashboard, or any standalone send).
 *
 * Deterministic failures must not be retried: the contact is opted out,
 * the 24-hour window is closed (compliance — an invented template is
 * explicitly NOT an option), credentials are missing, or Meta returned a
 * permanent business error. Each of these aborts the run. Transient
 * failure classes (HTTP 429/5xx/network) are the only ones that consume
 * the task-level retry budget.
 */
export const sendMessageTask = task({
  id: 'send-single-message',
  maxDuration: 30,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
    factor: 2,
  },
  run: async (payload: {
    clientId: string;
    contactId: string;
    message: string;
    messageType: MessageType;
    messageId?: string;
  }) => {
    try {
      await sendWhatsAppMessage({
        clientId: payload.clientId,
        contactId: payload.contactId,
        messageBody: payload.message,
        messageType: payload.messageType,
        messageId: payload.messageId,
      });
    } catch (error) {
      const isDeterministic =
        error instanceof DeterministicSendingError ||
        (error instanceof WaSendError && !error.retryable);
      if (isDeterministic) {
        console.error('[send-message] aborting run (non-retryable)', {
          name: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message : String(error),
        });
        throw new AbortTaskRunError(
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    }
  },
});
