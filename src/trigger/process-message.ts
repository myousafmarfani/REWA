import { task } from '@trigger.dev/sdk/v3';
import { processInboundMessage } from '@/lib/agent';

export const processMessageTask = task({
  id: 'process-inbound-message',
  maxDuration: 60,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
    factor: 2,
  },
  run: async (payload: {
    clientId: string;
    contactId: string;
    inboundMessage: string;
    waMessageId: string;
    waTimestamp: string;
    inboundMessageRowId?: string | null;
  }) => {
    await processInboundMessage({
      clientId: payload.clientId,
      contactId: payload.contactId,
      inboundMessage: payload.inboundMessage,
      waMessageId: payload.waMessageId,
      waTimestamp: new Date(payload.waTimestamp),
      inboundMessageRowId: payload.inboundMessageRowId ?? null,
    });
  },
});
