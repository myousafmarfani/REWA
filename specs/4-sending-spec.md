# Spec 4: WhatsApp Sending Pipeline
# Project: rewa
# depends_on: 1-data-model-spec (campaigns, campaign_contacts, contacts),
#             2-cleaning-spec (clean contacts exist),
#             3-agent-core-spec (agent calls sendWhatsAppMessage)
# subagents: @compliance-reviewer (MUST review before any implementation) →
#            @backend-builder (implement) → @qa-reviewer (verify)
# mcps: supabase (read campaigns, write campaign_contacts),
#       context7 (WhatsApp Cloud API docs, Trigger.dev docs)

---

## Purpose

Implement the WhatsApp sending pipeline: both outbound campaign sends
(first-touch bulk messages) and single-message sends (agent responses
and human replies). Includes rate limiting, 24-hour window enforcement,
opt-out handling, and the Trigger.dev job queue.

Read the outreach-compliance skill before implementing anything here.
The @compliance-reviewer subagent must review this spec before
@backend-builder touches any code.

---

## Constraints from MEMORY.md

- Entry 4: WhatsApp Business Cloud API only. No Telegram, no Email.
- Entry 15: Trigger.dev for background jobs (open source, self-hostable).
- Entry 16: Billing is per-message for templates. Service window
  messages (agent replies within 24h) are FREE. Template messages
  outside the window cost money.
- Entry 16: Meta policy — task-specific agents only. The agent's scope
  must be enforced in the sending layer too.
- Entry 8: opted_out contacts must never receive a message.

---

## Module location

```
src/
  lib/
    sending/
      index.ts          -- exports sendWhatsAppMessage() + sendCampaign()
      client.ts         -- WhatsApp Cloud API HTTP client
      window.ts         -- 24-hour window check + management
      queue.ts          -- Trigger.dev task definitions
      rate-limiter.ts   -- per-number rate limiting
      types.ts          -- sending-specific types
  trigger/
    send-campaign.ts    -- Trigger.dev campaign send task
    send-message.ts     -- Trigger.dev single message send task
```

---

## Environment variables

```
# WhatsApp Cloud API
WA_API_VERSION=v19.0
WA_BASE_URL=https://graph.facebook.com

# Per-client at runtime (from client_config table — not env vars):
# wa_phone_number_id, wa_access_token, wa_webhook_secret
```

---

## client.ts — WhatsApp Cloud API HTTP client

```typescript
const WA_BASE = `https://graph.facebook.com/${process.env.WA_API_VERSION}`;

// Send a free-form text message (only valid within 24-hour window)
export async function sendTextMessage(params: {
  phoneNumberId: string;
  accessToken: string;
  to: string;           // E.164 phone number
  body: string;
}): Promise<{ wa_message_id: string }> {
  const res = await fetch(
    `${WA_BASE}/${params.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: params.to,
        type: 'text',
        text: { preview_url: false, body: params.body },
      }),
    }
  );

  if (!res.ok) {
    const error = await res.json();
    throw new WaSendError(error.error?.message, error.error?.code, params.to);
  }

  const data = await res.json();
  return { wa_message_id: data.messages[0].id };
}

// Send a template message (for campaign sends and out-of-window messages)
export async function sendTemplateMessage(params: {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  templateName: string;
  languageCode: string;           // e.g. 'en'
  components?: object[];          // template variable values
}): Promise<{ wa_message_id: string }> {
  // Same fetch pattern as above, type: 'template'
}

// Custom error class
export class WaSendError extends Error {
  constructor(
    message: string,
    public readonly waErrorCode: number,
    public readonly recipient: string
  ) { super(message); }
}
```

---

## window.ts — 24-hour service window management

```typescript
// The 24-hour window opens when a contact sends a message to the business.
// It resets with every new inbound message from the contact.
// Within the window: any message type can be sent (free).
// Outside the window: only approved templates (paid, outbound campaign use).

export function isWindowOpen(lastReplyAt: Date | null): boolean {
  if (!lastReplyAt) return false;
  const diff = Date.now() - lastReplyAt.getTime();
  return diff < 24 * 60 * 60 * 1000;   // 24 hours in ms
}

// Called every time agent/human sends a message:
// - If window was closed and we're sending a template: fine (campaign)
// - If window was closed and we're sending free-form text: ERROR —
//   this must never happen. Throw and log.

export function assertWindowOpen(
  lastReplyAt: Date | null,
  messageType: 'text' | 'template'
): void {
  if (messageType === 'text' && !isWindowOpen(lastReplyAt)) {
    throw new Error(
      'COMPLIANCE: Attempted to send free-form text outside 24-hour window. ' +
      'Use a template message for out-of-window sends.'
    );
  }
}
```

---

## Main sending function (index.ts)

```typescript
export async function sendWhatsAppMessage(params: {
  clientId: string;
  contactId: string;
  messageBody: string;
  messageType: 'agent_response' | 'human_reply' | 'campaign';
}): Promise<void> {

  // 1. Load contact: phone_e164, opted_out, last_reply_at, wa_window_open
  // 2. Load client_config: wa_phone_number_id, wa_access_token

  // 3. Hard gate: opted_out check
  if (contact.opted_out) {
    throw new Error('Contact is opted out — message not sent');
  }

  // 4. Window check
  const windowOpen = isWindowOpen(contact.last_reply_at);

  // 5. Route based on message type and window state:
  //    campaign → always use template (sendTemplateMessage)
  //    agent_response + window open → sendTextMessage (free)
  //    agent_response + window closed → queue template message
  //      (agent should not have triggered this — log warning)
  //    human_reply + window open → sendTextMessage (free)
  //    human_reply + window closed → sendTemplateMessage

  // 6. On successful send:
  //    - Update contact: wa_window_open = true, last_contacted_at = now()
  //    - Log to messages table via persist.ts (called from agent-core)

  // 7. On WaSendError:
  //    - Log error to message_logs
  //    - If error code indicates blocked/invalid number:
  //      update contact opted_out = true (Meta considers this a block)
}
```

---

## Trigger.dev tasks

### Campaign send task (trigger/send-campaign.ts)

```typescript
import { task, batch } from '@trigger.dev/sdk/v3';

export const sendCampaignTask = task({
  id: 'send-campaign',
  maxDuration: 3600,              // campaigns can run up to 1 hour
  run: async (payload: { campaignId: string; clientId: string }) => {

    // 1. Load campaign + client_config (template name, wa credentials)
    // 2. Load all campaign_contacts where status = 'pending'
    // 3. Update campaign status = 'running'

    // 4. Process in batches of 10 contacts
    //    For each contact:
    //    a. Skip if: opted_out = true OR status NOT 'clean' OR number_type != 'mobile'
    //       Mark skipped contacts: status = 'skipped' in campaign_contacts
    //    b. Rate limit: max 80 messages per second per number
    //       (WhatsApp Cloud API limit — use a token bucket or simple delay)
    //    c. sendTemplateMessage() with campaign template + personalised vars
    //    d. On success: update campaign_contacts status = 'sent', wa_message_id
    //    e. On failure: update status = 'failed', fail_reason
    //       Retry once after 5s for transient errors (5xx, network)
    //       Do NOT retry for 4xx (invalid number, blocked, template error)

    // 5. Update campaign: status = 'completed', completed_at, sent_count, failed_count
    // 6. Update contact: last_contacted_at = now() for all sent contacts

    // Rate limiting implementation:
    // Simple delay between sends: 1000ms / 80 = 12.5ms per message
    // Add 15ms delay between each send to stay safely under limit
    // For paused campaigns: check campaign.status before each batch
  },
});
```

### Single message send task (trigger/send-message.ts)

```typescript
export const sendMessageTask = task({
  id: 'send-single-message',
  maxDuration: 30,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 5000,
    factor: 2,
  },
  run: async (payload: {
    clientId: string;
    contactId: string;
    messageBody: string;
    messageType: 'agent_response' | 'human_reply';
  }) => {
    await sendWhatsAppMessage(payload);
  },
});
```

---

## Opt-out handling

When an inbound message contains opt-out keywords, the agent/webhook
must immediately:
1. Set contact.opted_out = true, opted_out_at = now()
2. Set contact.wa_window_open = false
3. NOT call processInboundMessage — skip agent entirely
4. Send one final template acknowledgement if required by local law
   (configurable per client_config — default: no acknowledgement)

Opt-out keywords (case-insensitive, checked on every inbound message
BEFORE gate checks in agent-core):
```typescript
const OPT_OUT_KEYWORDS = [
  'stop', 'unsubscribe', 'optout', 'opt out', 'opt-out',
  'remove me', 'don\'t contact', 'do not contact', 'cancel'
];
```

---

## Number quality monitoring

WhatsApp assigns a quality rating to each business phone number.
Check the rating periodically and pause sends if it drops:

```
GET https://graph.facebook.com/{WA_API_VERSION}/{phone-number-id}
    ?fields=quality_rating&access_token={token}
```

Quality rating values: GREEN | YELLOW | RED

Create a Trigger.dev scheduled task that runs every 6 hours:
- If rating = RED: pause all active campaigns for this client,
  notify the client's notification_email
- If rating = YELLOW: log warning, do not pause
- If rating = GREEN: resume paused campaigns if they were paused
  due to quality (not due to manual pause)

---

## API routes

```
POST /api/campaigns/:id/start
```
Validates campaign exists, status = 'draft' or 'scheduled', belongs to
current user's client_id. Triggers sendCampaignTask via Trigger.dev.

```
POST /api/campaigns/:id/pause
```
Sets campaign.status = 'paused'. The running Trigger.dev task checks
this flag before each batch and stops if paused.

```
POST /api/messages/send
```
For human agents sending a reply manually from the dashboard.
Body: `{ contact_id, message_body }`.
Validates human_controlled = true (human must have toggled on).
Triggers sendMessageTask.

---

## Verification checklist

- [ ] Send a template campaign to 5 test contacts — all show 'sent'
      in campaign_contacts, wa_message_id populated
- [ ] Send to an opted-out contact → skipped, not sent
- [ ] Send to a landline contact → skipped, not sent
- [ ] Trigger window check: simulate last_reply_at > 24h ago,
      attempt free-form send → throws compliance error
- [ ] Trigger window check: last_reply_at < 24h ago, free-form send
      → succeeds
- [ ] Opt-out keyword in inbound → contact.opted_out = true,
      agent does not respond
- [ ] Campaign pause mid-run → task stops within one batch
- [ ] Rate limit: send 100 messages — none hit 429 from WhatsApp API
- [ ] Quality monitor task runs and reads quality_rating
- [ ] All sends logged in campaign_contacts with correct status
