# Spec 6: Pipeline UI
# Project: rewa
# depends_on: ALL previous specs (1–5 must be fully implemented first)
# subagents: @domain-strategist (review UI flows) →
#            @backend-builder (implement) → @qa-reviewer (verify)
# mcps: supabase (realtime subscriptions, read all tables),
#       github (wacrm fork — read source before modifying)

---

## Purpose

Fork wacrm and adapt its UI to serve rewa's specific use case: AI-first
inbound conversation management with lead scoring, human takeover toggle,
hot lead indicators, and campaign management. The UI must surface the
AI agent's work — scores, signals, pipeline stages — as first-class
elements, not afterthoughts.

Read the real-estate-outreach-domain skill before designing any UI flow.
The pipeline stages and terminology must match how real estate agents
think, not generic CRM language.

---

## Constraints from MEMORY.md

- Entry 11: human_controlled toggle is in the chat header. Its state
  comes from the database, not local UI state.
- Entry 9: cold = blue, warm = orange, hot = red + star icon.
- Entry 10: hot lead flagged in UI with star icon when escalated.
- Entry 2: The agent IS the product — the UI must make it feel like the
  agent is doing the work, not a CRM the user operates.
- Entry 13: wacrm is a fork, not a rebuild. Modify what needs changing.
  Do not rewrite things that work.

---

## What to fork and what to change

### Keep from wacrm (do not touch)
- Auth flow (Supabase Auth integration)
- Base Next.js App Router structure
- Tailwind config
- Sidebar navigation structure
- Basic conversation list component (adapt, don't rewrite)

### Remove from wacrm
- Any Telegram/Email channel UI
- Any existing automation/flow builder (replaced by Trigger.dev tasks)
- Generic CRM pipeline labels ("Lead", "Prospect", "Customer")
- Any mock/demo data components

### Add to wacrm
- Lead score badges (cold/warm/hot with correct colours)
- Hot lead star icon + indicator
- Agent toggle in chat header
- AI agent activity indicator (shows agent is typing / active)
- Campaign management pages
- Contact import page
- pgvector property ingestion page (admin only)
- Lead score history timeline in contact detail
- CSV/XLSX export button

---

## Pages and routes

```
app/
  (auth)/
    login/              -- Supabase Auth login page
    page.tsx
  (dashboard)/
    layout.tsx          -- sidebar + header shell
    page.tsx            -- redirect to /conversations
    conversations/
      page.tsx          -- conversation inbox (list view)
      [id]/
        page.tsx        -- individual conversation + chat
    contacts/
      page.tsx          -- contacts list with filters
      import/
        page.tsx        -- file upload + import status
    campaigns/
      page.tsx          -- campaigns list
      new/
        page.tsx        -- create campaign form
      [id]/
        page.tsx        -- campaign detail + send controls
    pipeline/
      page.tsx          -- Kanban board view
    settings/
      page.tsx          -- client config, agent persona, notifications
      properties/
        page.tsx        -- pgvector property data management (admin)
    export/
      page.tsx          -- trigger export + download
```

---

## Component: LeadScoreBadge

Used everywhere a lead score is displayed.

```tsx
type LeadScore = 'cold' | 'warm' | 'hot';

const SCORE_CONFIG = {
  cold: {
    label: 'Cold',
    className: 'bg-blue-100 text-blue-700 border-blue-200',
  },
  warm: {
    label: 'Warm',
    className: 'bg-orange-100 text-orange-700 border-orange-200',
  },
  hot: {
    label: 'Hot',
    className: 'bg-red-100 text-red-700 border-red-200',
    icon: '⭐',             // star icon for hot leads
  },
};

export function LeadScoreBadge({ score }: { score: LeadScore }) {
  const config = SCORE_CONFIG[score];
  return (
    <span className={`
      inline-flex items-center gap-1 px-2 py-0.5
      text-xs font-medium border rounded-full
      ${config.className}
    `}>
      {config.icon && <span>{config.icon}</span>}
      {config.label}
    </span>
  );
}
```

---

## Component: AgentToggle (chat header)

Positioned in the conversation header, same position as the call
button in WhatsApp Web. Controls human_controlled on the contact.

```tsx
interface AgentToggleProps {
  contactId: string;
  clientId: string;
  initialValue: boolean;    // human_controlled from DB
}

export function AgentToggle({ contactId, clientId, initialValue }: AgentToggleProps) {
  const [humanControlled, setHumanControlled] = useState(initialValue);
  const [loading, setLoading] = useState(false);

  async function handleToggle() {
    setLoading(true);
    const newValue = !humanControlled;

    // Update in Supabase immediately (optimistic)
    setHumanControlled(newValue);

    const { error } = await supabase
      .from('contacts')
      .update({
        human_controlled: newValue,
        updated_at: new Date().toISOString()
      })
      .eq('id', contactId)
      .eq('client_id', clientId);

    if (error) {
      // Revert on failure
      setHumanControlled(!newValue);
      toast.error('Failed to update agent control');
    }

    setLoading(false);
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500">
        {humanControlled ? 'You' : 'AI'}
      </span>
      <button
        onClick={handleToggle}
        disabled={loading}
        className={`
          relative inline-flex h-5 w-9 items-center rounded-full
          transition-colors duration-200
          ${humanControlled ? 'bg-gray-300' : 'bg-blue-500'}
          ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        `}
        aria-label={humanControlled ? 'AI agent off — you are handling' : 'AI agent on'}
      >
        <span className={`
          inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow
          transition-transform duration-200
          ${humanControlled ? 'translate-x-1' : 'translate-x-4'}
        `} />
      </button>
      <span className="text-xs text-gray-400">
        {humanControlled ? 'handling' : 'agent'}
      </span>
    </div>
  );
}
```

---

## Page: Conversation inbox (conversations/page.tsx)

List of all conversations for the current client, ordered by
last_message_at desc.

Each row shows:
- Contact name + phone
- LeadScoreBadge (cold/warm/hot)
- ⭐ icon if hot_flagged_at is set
- Last message preview (last_message_preview from conversations table)
- Time since last message
- Assigned agent avatar (if assigned_to is set)
- Unread count badge

Filters (sidebar or top bar):
- All | Mine (assigned_to = current user)
- Score: All | Cold | Warm | Hot
- Stage: All | [each pipeline stage]
- Status: Open | Resolved

Realtime: subscribe to conversations table changes via Supabase Realtime.
New messages → update last_message_preview and unread_count live.

```typescript
// Supabase Realtime subscription
const channel = supabase
  .channel('conversations')
  .on('postgres_changes', {
    event: 'UPDATE',
    schema: 'public',
    table: 'conversations',
    filter: `client_id=eq.${clientId}`,
  }, (payload) => {
    // Update the conversation row in local state
  })
  .subscribe();
```

---

## Page: Individual conversation (conversations/[id]/page.tsx)

Split view:
- Left (30%): Contact detail panel
  - Name, phone, email
  - LeadScoreBadge (live, updates via Realtime)
  - Pipeline stage selector (dropdown, updates contact)
  - Lead score history timeline
  - Assigned to selector
  - Notes (free text, stored in contacts table)

- Right (70%): Chat panel
  - Header: contact name | LeadScoreBadge | AgentToggle | [phone icon]
  - Message list (messages table, ordered by created_at asc)
    - Inbound messages: left-aligned, white bubble
    - Outbound agent messages: right-aligned, blue bubble
    - Outbound human messages: right-aligned, green bubble
    - Show sender_type label under each message (small, muted)
  - Input area: only enabled when human_controlled = true
    - If human_controlled = false: show "AI agent is handling this
      conversation. Toggle to take over." (non-interactive)
    - If human_controlled = true: show text input + send button

Message display — show agent signals inline (collapsed by default):
- Each agent outbound message has a small chevron "▸ AI signals"
- Expanding shows: intent_type, lead_score at time, signals object
- This gives human agents visibility into why the AI scored the lead

---

## Page: Pipeline Kanban (pipeline/page.tsx)

7 columns, one per pipeline stage:
New lead | Contacted | Qualified | Viewing booked |
Offer made | Negotiation | Closed won / Closed lost

Each card shows:
- Contact name
- LeadScoreBadge
- ⭐ if hot_flagged_at is set
- Last message preview (20 chars)
- Time since last activity

Drag-and-drop: moving a card updates contact.pipeline_stage in Supabase.
Use @dnd-kit/core for drag-and-drop (already in wacrm or add it).

Realtime: subscribe to contacts table changes to update cards live.

---

## Page: Campaign management (campaigns/page.tsx)

List of campaigns with columns:
Name | Status | Template | Contacts | Sent | Failed | Created | Actions

Status badges:
- draft: gray
- scheduled: blue
- running: orange (with animated pulse dot)
- completed: green
- failed: red

Actions per campaign:
- Draft: Edit | Delete | Start
- Scheduled: Cancel
- Running: Pause | View progress
- Completed: View report | Duplicate
- Failed: View error | Retry

---

## Page: Create campaign (campaigns/new/page.tsx)

Step 1: Name + select contacts
- Filter by: score (cold/warm/hot), region, status = 'clean',
  number_type = 'mobile', not opted_out
- Show count of eligible contacts

Step 2: Choose template
- List Meta-approved templates from client_config
  (or fetch from WhatsApp API: GET /{phone-number-id}/message_templates)
- Preview with variable slots highlighted

Step 3: Schedule or send now
- Send now: triggers sendCampaignTask immediately
- Schedule: sets campaign.scheduled_at, Trigger.dev handles timing

---

## Page: Settings (settings/page.tsx)

Sections:
1. Agent persona: name, tone, language, sign-off, escalation phrase
2. Brand: company name, logo upload
3. WhatsApp: phone number ID, access token (masked), webhook URL display
4. Notifications: notification_email for hot lead alerts
5. Region priority: drag-to-reorder list of regions

All settings map to client_config columns.
Save button: upsert client_config for current client_id.

---

## Page: Properties / pgvector (settings/properties/page.tsx)

Admin-only page for ingesting property data into pgvector.

- List existing properties (grouped by property_id, showing chunk_types)
- Upload form: property_id + list of chunks (chunk_type + content text)
- On submit: calls POST /api/properties/ingest
- Delete property: removes all embeddings for that property_id

---

## Realtime subscriptions summary

Subscribe to these tables on the dashboard layout level:
- conversations: update inbox list
- contacts: update lead scores, toggle state
- messages: new messages in open conversation
- campaigns: update campaign status in list

Unsubscribe on component unmount.

---

## Verification checklist

- [ ] Conversation inbox shows all conversations with correct score badges
- [ ] Hot lead shows ⭐ icon in inbox and on Kanban card
- [ ] AgentToggle updates human_controlled in DB immediately
- [ ] When human_controlled = true: chat input is enabled, agent is blocked
- [ ] When human_controlled = false: chat input shows "AI handling" message
- [ ] Agent messages show blue bubble, human messages show green bubble
- [ ] Expanding AI signals on a message shows correct intent + signals
- [ ] Kanban: dragging card updates contact.pipeline_stage in DB
- [ ] Realtime: new inbound message appears in open conversation < 2s
- [ ] Realtime: lead score badge updates live when score changes
- [ ] Campaign list shows correct status badge and counts
- [ ] Create campaign: contact count updates as filters change
- [ ] Settings save: client_config updated, agent uses new persona on next message
- [ ] Properties page: ingest 2 property chunks, verify similarity search returns them
- [ ] Export page: download generates correct XLSX with all contacts
