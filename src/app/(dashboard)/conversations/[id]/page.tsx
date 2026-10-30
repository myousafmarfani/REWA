"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Send } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { LeadScoreBadge } from "@/components/rewa/lead-score-badge";
import { AgentToggle } from "@/components/rewa/agent-toggle";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface ContactRow {
  id: string;
  full_name: string | null;
  phone_e164: string;
  lead_score: string;
  pipeline_stage: string;
  human_controlled: boolean;
  opted_out: boolean;
  requirements: unknown;
}

interface ConversationRow {
  id: string;
  contact_id: string;
  status: string;
  last_message_at: string | null;
  contact: ContactRow | null;
}

interface MessageRow {
  id: string;
  direction: string;
  sender_type: string;
  body: string;
  status: string;
  created_at: string;
  wa_timestamp: string | null;
  agent_intent_type: string | null;
  agent_lead_score: string | null;
  agent_signals: unknown;
}

const STAGE_LABELS: Record<string, string> = {
  new_lead: "New lead",
  contacted: "Contacted",
  qualified: "Qualified",
  viewing_booked: "Viewing booked",
  offer_made: "Offer made",
  negotiation: "Negotiation",
};

function displayName(c: ContactRow | null): string {
  return c?.full_name?.trim() || c?.phone_e164 || "Unknown contact";
}

export default function ConversationDetailPage() {
  const params = useParams<{ id: string }>();
  const conversationId = params?.id;

  const [conversation, setConversation] = useState<ConversationRow | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [togglePending, setTogglePending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadConversation = useCallback(async () => {
    if (!conversationId) return;
    const supabase = createClient();
    const { data, error: err } = await supabase
      .from("conversations")
      .select(
        `id, contact_id, status, last_message_at,
         contact:contacts!inner(
           id, full_name, phone_e164, lead_score, pipeline_stage,
           human_controlled, opted_out, requirements
         )`,
      )
      .eq("id", conversationId)
      .maybeSingle();
    if (err) setError(err.message);
    else setConversation((data as unknown as ConversationRow) ?? null);
  }, [conversationId]);

  const loadMessages = useCallback(async () => {
    if (!conversationId) return;
    const supabase = createClient();
    const { data, error: err } = await supabase
      .from("messages")
      .select(
        "id, direction, sender_type, body, status, created_at, wa_timestamp, agent_intent_type, agent_lead_score, agent_signals",
      )
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (err) setError(err.message);
    else setMessages((data as MessageRow[]) ?? []);
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all([loadConversation(), loadMessages()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadConversation, loadMessages]);

  useEffect(() => {
    if (!conversationId) return;
    const supabase = createClient();

    // "sent"/"delivered"/"read" status updates arrive as UPDATEs, so we
    // listen to ALL events on this conversation's messages, not just
    // INSERT — otherwise the ticks never advance.
    const channel = supabase
      .channel(`conversation-${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => {
          loadMessages();
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "contacts" },
        () => {
          loadConversation();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId, loadMessages, loadConversation]);

  // Pin to the newest message whenever the thread grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const contact = conversation?.contact ?? null;
  const humanControlled = contact?.human_controlled ?? false;

  const toggleAgent = useCallback(
    async (next: boolean) => {
      if (!contact) return;
      setTogglePending(true);
      setConversation((prev) =>
        prev?.contact
          ? { ...prev, contact: { ...prev.contact, human_controlled: next } }
          : prev,
      );
      const supabase = createClient();
      const { error: err } = await supabase
        .from("contacts")
        .update({ human_controlled: next })
        .eq("id", contact.id);
      if (err) {
        setConversation((prev) =>
          prev?.contact
            ? {
                ...prev,
                contact: { ...prev.contact, human_controlled: !next },
              }
            : prev,
        );
        toast.error("Could not update agent control", { description: err.message });
      }
      setTogglePending(false);
    },
    [contact],
  );

  const sendReply = useCallback(async () => {
    const text = draft.trim();
    if (!text || !contact) return;
    setSending(true);
    try {
      const res = await fetch("/api/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contact.id, message: text }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? `Send failed (${res.status})`);
      }
      setDraft("");
      // The send task persists the row; realtime will pull it in. Nudge a
      // refetch too in case the channel is briefly behind.
      loadMessages();
    } catch (err) {
      toast.error("Message not sent", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSending(false);
    }
  }, [draft, contact, loadMessages]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error || !conversation) {
    return (
      <div className="mx-auto max-w-2xl">
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link href="/conversations" />}
        >
          <ArrowLeft /> Back
        </Button>
        <p className="mt-4 text-sm text-destructive">
          {error ?? "Conversation not found."}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <div className="flex items-center gap-3 pb-3">
        <Button
          variant="ghost"
          size="icon-sm"
          nativeButton={false}
          aria-label="Back to conversations"
          render={<Link href="/conversations" />}
        >
          <ArrowLeft />
        </Button>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">
              {displayName(contact)}
            </span>
            {contact ? <LeadScoreBadge score={contact.lead_score} /> : null}
            {contact?.pipeline_stage ? (
              <Badge variant="outline">
                {STAGE_LABELS[contact.pipeline_stage] ?? contact.pipeline_stage}
              </Badge>
            ) : null}
          </div>
          <span className="text-xs text-muted-foreground">
            {contact?.phone_e164}
          </span>
        </div>
        {contact ? (
          <div className="ml-auto">
            <AgentToggle
              humanControlled={humanControlled}
              pending={togglePending}
              onChange={toggleAgent}
            />
          </div>
        ) : null}
      </div>

      {contact?.opted_out ? (
        <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          This contact opted out — do not message them. The agent is
          permanently suppressed.
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto rounded-xl border border-border bg-muted/20 p-4"
      >
        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No messages in this thread yet.
          </p>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </div>

      <div className="mt-3">
        {humanControlled ? (
          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type your reply…"
              rows={2}
              className="min-h-16 resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  sendReply();
                }
              }}
            />
            <Button
              onClick={sendReply}
              disabled={sending || !draft.trim()}
              aria-label="Send reply"
            >
              <Send />
              Send
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground">
            The agent is handling this conversation. Switch to{" "}
            <span className="font-medium text-foreground">Human</span> to
            reply manually.
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: MessageRow }) {
  const [showSignals, setShowSignals] = useState(false);
  const outbound = message.direction === "outbound";
  const isAgent =
    message.sender_type === "agent" || message.sender_type === "bot";
  const isHuman = message.sender_type === "human" || message.sender_type === "user";
  const when = message.wa_timestamp ?? message.created_at;

  // Spec C11: agent outbound messages expose an "AI signals" disclosure so
  // a human taking over can see why the agent scored the lead.
  const hasSignals =
    isAgent &&
    (message.agent_intent_type != null ||
      message.agent_lead_score != null ||
      message.agent_signals != null);

  const senderLabel = isAgent ? "AI agent" : isHuman ? "You" : "Contact";

  return (
    <div
      className={cn(
        "flex flex-col gap-1",
        outbound ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
          // Blue for agent, green for human — both outbound (spec C11).
          outbound && isHuman
            ? "rounded-br-sm bg-emerald-600 text-white"
            : outbound
              ? "rounded-br-sm bg-primary text-primary-foreground"
              : "rounded-bl-sm bg-card text-foreground ring-1 ring-foreground/10",
        )}
      >
        {message.body}
        <span
          className={cn(
            "mt-1 flex items-center gap-2 text-[10px]",
            outbound ? "text-white/70" : "text-muted-foreground",
          )}
        >
          <span>{timestamp(when)}</span>
          {message.status === "failed" ? <span>· failed</span> : null}
          <span className="uppercase tracking-wide">{senderLabel}</span>
        </span>
      </div>

      {hasSignals ? (
        <button
          type="button"
          onClick={() => setShowSignals((v) => !v)}
          className="px-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
          aria-expanded={showSignals}
        >
          {showSignals ? "▾" : "▸"} AI signals
        </button>
      ) : null}

      {showSignals && hasSignals ? (
        <div className="max-w-[80%] rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
            <dt className="text-muted-foreground">Intent</dt>
            <dd className="font-medium">{message.agent_intent_type ?? "—"}</dd>
            <dt className="text-muted-foreground">Score at time</dt>
            <dd className="font-medium">{message.agent_lead_score ?? "—"}</dd>
          </dl>
          {message.agent_signals &&
          typeof message.agent_signals === "object" ? (
            <ul className="mt-1.5 border-t border-border pt-1.5">
              {Object.entries(
                message.agent_signals as Record<string, unknown>,
              ).map(([key, value]) => (
                <li key={key} className="flex justify-between gap-2">
                  <span className="text-muted-foreground">{key}</span>
                  <span className="font-medium">
                    {typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function timestamp(iso: string | null): string {
  if (!iso) return "";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "";
  }
}
