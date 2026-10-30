---
name: real-estate-outreach-domain
description: Real estate industry knowledge — buyer/agent/broker personas, deal stages, regional market differences, and objection patterns. Load before any feature touching lead qualification, pipeline stages, messaging tone, or customer-facing copy.
---

# Real Estate Outreach Domain Knowledge

## The core problem rewa solves

Real estate outreach has two broken halves that no one ties together:
- Upstream: agents sit on messy contact exports (CRM dumps, portal
  leads, event scans) with no way to clean, prioritise, and reach them
  reliably at scale.
- Downstream: replies land in personal WhatsApp with no shared pipeline,
  no scoring, no visibility across a team. Deals get lost.
rewa solves both. The AI agent is what makes the downstream half work
without hiring a full sales team.

## Three client types

Solo agent / broker
- One person, phone full of leads, no tech skill, no time.
- Judges the product on a single outcome: "did I get a qualified
  conversation that moved toward a viewing or deal?"
- Does not care about features. Cares about results.
- Delivery: Model A (managed service). We run everything.

Boutique agency (5–30 agents)
- Multiple agents, leads scattered across personal WhatsApp chats.
- No shared visibility — one agent can't see another's conversations.
- Has an ops/admin person. Wants a dashboard, assignment, pipeline view.
- Delivery: Model A or B depending on data ownership preferences.

Brokerage / developer (enterprise)
- Runs large property launch campaigns — hundreds to thousands of leads.
- Has compliance concerns (WhatsApp number quality, data residency).
- Wants the platform to look and feel like their own product (their
  agent name, their domain, their branding).
- Delivery: Model B (white-label self-hosted). They own the infra.

## Pipeline stages rewa maps to

New lead → Contacted → Qualified → Viewing booked → Offer made →
Negotiation → Closed won / Closed lost.

The AI agent's job is to move contacts from "New lead" to "Viewing
booked" autonomously. Anything beyond "Viewing booked" is where a human
agent typically takes over (triggered by hot lead escalation).

## Lead scoring signal patterns

Cold signals: "just looking", "send me some info", no budget mention,
asking generic questions not tied to a specific unit or development.

Warm signals: asking about a specific unit or floor, asking about
payment plans, ROI, or rental yield, requesting floor plans or brochures,
mentioning a timeline ("I want to buy before end of year").

Hot signals: "can I visit this weekend", "what's the final price if I
pay cash", "can we negotiate", "I want to proceed", "send me the
contract details". These are explicit closing signals that trigger human
escalation immediately.

## Regional context affecting agent tone and messaging

UAE / GCC markets:
- WhatsApp is the dominant communication channel — expected, not unusual.
- Investor-buyer relationships common; ROI and rental yield are strong
  motivators alongside lifestyle.
- Off-plan and payment plan conversations are standard — agent must be
  fluent in payment structure discussions.
- High-value deals — agent tone should be professional but warm, not
  pushy or scripted-sounding.

Western markets (US, UK, EU):
- Email and more formal communication expected initially.
- Higher regulatory sensitivity to unsolicited outreach.
- End-user buyers more common than investors — school districts, move-in
  timelines, family needs are relevant context.
- Agent tone should be low-pressure and consultative.

South Asian markets:
- High rate of price-shopping — more "what is your best price" than
  genuine closing signals early in conversation.
- Agent should qualify budget and timeline earlier in conversation to
  avoid extended engagement with non-buyers.

## Objection patterns the agent must handle fluently

- "Is this a real person?" — never confirm or deny AI. Redirect warmly.
- "Send me more info" — ask what specifically they want to know before
  sending generic content.
- "Is the price negotiable?" — confirm what the standard terms are from
  pgvector, then escalate to hot if they push further.
- "I need to talk to my wife/partner/bank" — acknowledge, set a
  follow-up intent, stay warm without being pushy.
- "I'm not interested anymore" — gracefully close, log, update score.
