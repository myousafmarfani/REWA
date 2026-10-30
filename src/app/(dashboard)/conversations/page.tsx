"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, MessageSquare, Sparkles } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

import { createClient } from "@/lib/supabase/client";
import { LeadScoreBadge } from "@/components/rewa/lead-score-badge";
import { AgentToggle } from "@/components/rewa/agent-toggle";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface InboxContact {
  id: string;
  full_name: string | null;
  phone_e164: string;
  lead_score: string;
  human_controlled: boolean;
  opted_out: boolean;
  last_inbound_at: string | null;
}

interface InboxConversation {
  id: string;
  contact_id: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  status: string;
  contact: InboxContact | null;
}

const SELECT = `
  id,
  contact_id,
  last_message_at,
  last_message_preview,
  unread_count,
  status,
  contact:contacts!inner(
    id, full_name, phone_e164, lead_score, human_controlled, opted_out, last_inbound_at
  )
`;

/** Sort hot leads above everything else, then most-unread, then oldest
 *  inbound (longest waiting). Domain-strategist: "Needs attention" is a
 *  triage queue, not a recency feed. */
function byNeedsAttention(a: InboxConversation, b: InboxConversation): number {
  if (b.unread_count !== a.unread_count) return b.unread_count - a.unread_count;
  const at = a.contact?.last_inbound_at ?? "";
  const bt = b.contact?.last_inbound_at ?? "";
  return at < bt ? -1 : at > bt ? 1 : 0;
}

function byRecency(a: InboxConversation, b: InboxConversation): number {
  const at = a.last_message_at ?? "";
  const bt = b.last_message_at ?? "";
  return bt < at ? -1 : bt > at ? 1 : 0;
}

function displayName(c: InboxContact | null): string {
  return c?.full_name?.trim() || c?.phone_e164 || "Unknown contact";
}

function timestamp(iso: string | null): string {
  if (!iso) return "";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "";
  }
}

export default function ConversationsPage() {
  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);
  // Debounce realtime bursts (a single inbound can touch messages +
  // conversations) so we refetch once, not N times.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data, error: err } = await supabase
      .from("conversations")
      .select(SELECT)
      .order("last_message_at", { ascending: false, nullsFirst: false });

    if (err) {
      setError(err.message);
    } else {
      setConversations((data as unknown as InboxConversation[]) ?? []);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // The setState calls inside load() run after the Supabase await,
    // not synchronously in the effect body — the cascade the lint rule
    // warns about doesn't apply, so the guard is disabled here (same
    // convention as the contacts page).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();

    const supabase = createClient();
    const scheduleRefetch = () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(load, 400);
    };

    const channel = supabase
      .channel("inbox-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        scheduleRefetch,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        scheduleRefetch,
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "contacts" },
        scheduleRefetch,
      )
      .subscribe();

    return () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      supabase.removeChannel(channel);
    };
  }, [load]);

  const toggleAgent = useCallback(
    async (contactId: string, next: boolean) => {
      setPendingToggle(contactId);
      // Optimistic — realtime will reconcile, but the switch should feel
      // instant. Flip the local copy first.
      setConversations((prev) =>
        prev.map((c) =>
          c.contact?.id === contactId
            ? {
                ...c,
                contact: c.contact
                  ? { ...c.contact, human_controlled: next }
                  : c.contact,
              }
            : c,
        ),
      );
      const supabase = createClient();
      const { error: err } = await supabase
        .from("contacts")
        .update({ human_controlled: next })
        .eq("id", contactId);
      if (err) {
        // Roll back on failure.
        setConversations((prev) =>
          prev.map((c) =>
            c.contact?.id === contactId
              ? {
                  ...c,
                  contact: c.contact
                    ? { ...c.contact, human_controlled: !next }
                    : c.contact,
                }
              : c,
          ),
        );
        setError(err.message);
      }
      setPendingToggle(null);
    },
    [],
  );

  const { attention, rest } = useMemo(() => {
    const attentionRows: InboxConversation[] = [];
    const restRows: InboxConversation[] = [];
    for (const c of conversations) {
      if (
        c.contact?.lead_score === "hot" &&
        !c.contact?.opted_out &&
        c.status !== "closed"
      ) {
        attentionRows.push(c);
      } else {
        restRows.push(c);
      }
    }
    attentionRows.sort(byNeedsAttention);
    restRows.sort(byRecency);
    return { attention: attentionRows, rest: restRows };
  }, [conversations]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      {error ? (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {attention.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2 flex items-center gap-1.5 px-1 text-xs font-semibold tracking-wide text-rose-600 uppercase dark:text-rose-400">
            <Sparkles className="size-3.5" aria-hidden="true" /> Needs attention
          </h2>
          <div className="flex flex-col gap-2">
            {attention.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                highlighted
                pending={pendingToggle === c.contact?.id}
                onToggle={toggleAgent}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          All conversations
        </h2>
        {rest.length === 0 && attention.length === 0 ? (
          <Card className="items-center gap-2 p-10 text-center">
            <MessageSquare className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No conversations yet.
            </p>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {rest.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                pending={pendingToggle === c.contact?.id}
                onToggle={toggleAgent}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ConversationRow({
  conversation: c,
  highlighted = false,
  pending = false,
  onToggle,
}: {
  conversation: InboxConversation;
  highlighted?: boolean;
  pending?: boolean;
  onToggle: (contactId: string, next: boolean) => void;
}) {
  const contact = c.contact;
  return (
    <Card
      size="sm"
      className={cn(
        "flex-row items-center gap-3 px-3 transition-colors hover:bg-muted/40",
        highlighted && "ring-rose-500/30",
      )}
    >
      <Link
        href={`/conversations/${c.id}`}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
          {displayName(contact).charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {displayName(contact)}
            </span>
            {contact ? <LeadScoreBadge score={contact.lead_score} /> : null}
            {contact?.opted_out ? (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle aria-hidden="true" /> Opted out
              </Badge>
            ) : null}
            {c.unread_count > 0 && !highlighted ? (
              <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                {c.unread_count > 99 ? "99+" : c.unread_count}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {c.last_message_preview ?? "No messages yet"}
          </p>
        </div>
        <span className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground">
          {timestamp(c.last_message_at)}
        </span>
      </Link>
      {contact ? (
        <div className="shrink-0 border-l border-border pl-3">
          <AgentToggle
            compact
            humanControlled={contact.human_controlled}
            pending={pending}
            onChange={(next) => onToggle(contact.id, next)}
          />
        </div>
      ) : null}
    </Card>
  );
}
