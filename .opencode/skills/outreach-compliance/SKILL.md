---
name: outreach-compliance
description: Messaging compliance constraints for WhatsApp Business Cloud API — template rules, 24-hour window, rate limits, number quality, and opt-out requirements. Load before any sending, template, rate-limiting, or opt-out work. Mandatory before sending-spec begins.
---

# Outreach Compliance — WhatsApp Focus

> Current build scope is WhatsApp only. Email (AWS SES) and Telegram
> compliance rules are documented below for future reference but must
> not drive current implementation decisions.

## WhatsApp Business Cloud API — rules the agent and sender must follow

### The 24-hour messaging window
- Free-form messages (any content, any format) can only be sent within
  a 24-hour window AFTER the contact last sent a message to the business.
- Outside that window, only pre-approved Meta message templates may
  initiate contact.
- The autonomous agent must check the window state before every outbound
  message. If the window is closed, it must use an approved template or
  queue the message until the window reopens (when the contact replies).
- This is the most critical compliance rule in the product. Violating it
  risks the WhatsApp Business number being restricted or banned.

### Message templates
- Templates used outside the 24-hour window must be submitted to Meta
  and approved before use in production.
- Templates have defined variable slots ({1}, {2}, etc.) — the agent
  may personalise within the slots but cannot change the template
  structure at send time.
- Build the sending-spec and agent-core-spec with template approval
  latency in mind — a new template cannot be used the same day it is
  submitted.

### Phone number quality rating
- Meta assigns each WhatsApp Business number a quality rating based on
  user block/report rates and opt-out rates.
- Sending high volumes to unqualified contacts degrades the rating.
- A degraded rating causes throttling; a "Low" sustained rating can
  result in the number being flagged or disabled.
- The sending queue must implement per-number health monitoring and
  pause sending if the quality rating drops below a threshold.
- This is why contact cleaning (dedup, number validation, region
  filtering) is a prerequisite to sending — not a nice-to-have.

### Rate limits
- WhatsApp Business Cloud API has per-number and per-tier rate limits
  on messages per second and per day.
- The Inngest/Trigger.dev job queue must enforce these limits natively —
  not rely on application-level retries alone.
- Rate limit errors must be caught, logged, and retried with exponential
  backoff — not silently dropped.

### Opt-out handling
- Every contact must have a working, honoured opt-out path.
- If a contact sends "stop", "unsubscribe", or equivalent, the agent
  must immediately stop responding and flag the contact as opted-out in
  Supabase.
- Opted-out contacts must never receive another message, even from a
  campaign. This is enforced at the database level (opted_out boolean)
  checked before every send.

### What the autonomous agent must never do
- Send a free-form message to a contact outside the 24-hour window.
- Fabricate or infer property data not present in pgvector.
- Confirm or deny that it is an AI when asked.
- Make pricing commitments beyond what is in the pgvector property data.
- Continue messaging a contact who has opted out.
- Respond to a contact where human_controlled = true.

## Email compliance (future reference — not current scope)

SES warm-up, bounce/complaint handling, and regional consent rules
(GDPR, CAN-SPAM) will apply when Email is added. Do not build for these
now — document here when Email scope is officially opened.

## Telegram compliance (future reference — not current scope)

MTProto session management, anti-spam rules, and group messaging
constraints apply. Do not build for these now.
