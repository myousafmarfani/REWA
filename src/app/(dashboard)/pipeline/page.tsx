"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Lock, Star } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { LeadScoreBadge } from "@/components/rewa/lead-score-badge";
import { cn } from "@/lib/utils";
import type { PipelineStage } from "@/lib/agent/types";

/**
 * Pipeline Kanban (Spec 6 C12).
 *
 * Six stored stages (contacts.pipeline_stage) plus one DERIVED, read-only
 * "Closed" column. The DB has no closed stage value — domain-strategist
 * review (Spec 6) was explicit that inventing one would corrupt the
 * scoring/sending invariants. A contact is "closed" when they opted out
 * or were marked invalid; those cards are terminal and cannot be dragged
 * back into the funnel (that would silently re-open a suppressed lead).
 */

const STAGES: { id: PipelineStage; label: string }[] = [
  { id: "new_lead", label: "New lead" },
  { id: "contacted", label: "Contacted" },
  { id: "qualified", label: "Qualified" },
  { id: "viewing_booked", label: "Viewing booked" },
  { id: "offer_made", label: "Offer made" },
  { id: "negotiation", label: "Negotiation" },
];

const CLOSED_COLUMN = "closed";

interface PipelineContact {
  id: string;
  full_name: string | null;
  phone_e164: string;
  lead_score: string;
  pipeline_stage: string;
  hot_flagged_at: string | null;
  opted_out: boolean;
  status: string;
  last_inbound_at: string | null;
  updated_at: string;
}

function isClosed(c: PipelineContact): boolean {
  return c.opted_out || c.status === "invalid";
}

function displayName(c: PipelineContact): string {
  return c.full_name?.trim() || c.phone_e164;
}

function activityAt(c: PipelineContact): string {
  return c.last_inbound_at ?? c.updated_at;
}

export default function PipelinePage() {
  const [contacts, setContacts] = useState<PipelineContact[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("contacts")
      .select(
        "id, full_name, phone_e164, lead_score, pipeline_stage, hot_flagged_at, opted_out, status, last_inbound_at, updated_at",
      )
      .order("updated_at", { ascending: false });
    if (error) {
      toast.error("Could not load pipeline", { description: error.message });
    } else {
      setContacts((data as PipelineContact[]) ?? []);
    }

    const { data: convs } = await supabase
      .from("conversations")
      .select("contact_id, last_message_preview");
    if (convs) {
      const map: Record<string, string> = {};
      for (const row of convs as {
        contact_id: string;
        last_message_preview: string | null;
      }[]) {
        if (row.last_message_preview) map[row.contact_id] = row.last_message_preview;
      }
      setPreviews(map);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // The setState calls inside load() run after the Supabase awaits,
    // not synchronously in the effect body — the cascade the lint rule
    // warns about doesn't apply, so the guard is disabled here (same
    // convention as the contacts page).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const supabase = createClient();
    const schedule = () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(load, 400);
    };
    const channel = supabase
      .channel("pipeline-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "contacts" },
        schedule,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        schedule,
      )
      .subscribe();
    return () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      supabase.removeChannel(channel);
    };
  }, [load]);

  const sensors = useSensors(
    // 6px activation distance so a click (future: open contact) isn't
    // swallowed by the drag handler.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const grouped = useMemo(() => {
    const groups: Record<string, PipelineContact[]> = {};
    for (const s of STAGES) groups[s.id] = [];
    groups[CLOSED_COLUMN] = [];
    for (const c of contacts) {
      if (isClosed(c)) {
        groups[CLOSED_COLUMN].push(c);
      } else if (groups[c.pipeline_stage]) {
        groups[c.pipeline_stage].push(c);
      } else {
        // Unknown/free-text stage — surface it under New lead rather than
        // dropping the contact off the board entirely.
        groups.new_lead.push(c);
      }
    }
    return groups;
  }, [contacts]);

  const activeContact = activeId
    ? contacts.find((c) => c.id === activeId) ?? null
    : null;

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveId(null);
      const contactId = String(event.active.id);
      const overId = event.over?.id ? String(event.over.id) : null;
      if (!overId || overId === CLOSED_COLUMN) return;

      const contact = contacts.find((c) => c.id === contactId);
      if (!contact || isClosed(contact)) return;
      if (contact.pipeline_stage === overId) return;

      const previousStage = contact.pipeline_stage;
      // Optimistic move.
      setContacts((prev) =>
        prev.map((c) =>
          c.id === contactId ? { ...c, pipeline_stage: overId } : c,
        ),
      );

      const supabase = createClient();
      const { error } = await supabase
        .from("contacts")
        .update({ pipeline_stage: overId })
        .eq("id", contactId);
      if (error) {
        setContacts((prev) =>
          prev.map((c) =>
            c.id === contactId ? { ...c, pipeline_stage: previousStage } : c,
          ),
        );
        toast.error("Could not move card", { description: error.message });
      }
    },
    [contacts],
  );

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full gap-4 overflow-x-auto pb-4">
        {STAGES.map((stage) => (
          <Column
            key={stage.id}
            id={stage.id}
            label={stage.label}
            cards={grouped[stage.id] ?? []}
            previews={previews}
          />
        ))}
        <Column
          id={CLOSED_COLUMN}
          label="Closed won / Closed lost"
          cards={grouped[CLOSED_COLUMN] ?? []}
          previews={previews}
          readOnly
        />
      </div>

      <DragOverlay dropAnimation={null}>
        {activeContact ? (
          <KanbanCard contact={activeContact} preview={previews[activeContact.id]} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  id,
  label,
  cards,
  previews,
  readOnly = false,
}: {
  id: string;
  label: string;
  cards: PipelineContact[];
  previews: Record<string, string>;
  readOnly?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: readOnly });

  return (
    <div className="flex w-72 shrink-0 flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </h2>
        <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
          {cards.length}
        </span>
        {readOnly ? (
          <Lock className="ml-auto size-3 text-muted-foreground" aria-hidden="true" />
        ) : null}
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-32 flex-1 flex-col gap-2 rounded-xl border border-dashed border-border p-2 transition-colors",
          isOver && !readOnly && "border-primary/60 bg-primary/5",
          readOnly && "bg-muted/30",
        )}
      >
        {cards.map((c) => (
          <DraggableCard
            key={c.id}
            contact={c}
            preview={previews[c.id]}
            readOnly={readOnly}
          />
        ))}
        {cards.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {readOnly ? "No closed leads" : "Drop a card here"}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function DraggableCard({
  contact,
  preview,
  readOnly,
}: {
  contact: PipelineContact;
  preview?: string;
  readOnly: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: contact.id, disabled: readOnly });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("touch-none", isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
    >
      <KanbanCard contact={contact} preview={preview} readOnly={readOnly} />
    </div>
  );
}

function KanbanCard({
  contact,
  preview,
  readOnly = false,
}: {
  contact: PipelineContact;
  preview?: string;
  readOnly?: boolean;
}) {
  return (
    <div className="group rounded-lg border border-border bg-card p-2.5 shadow-sm">
      <div className="flex items-center gap-1.5">
        {!readOnly ? (
          <GripVertical
            className="size-3.5 shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground"
            aria-hidden="true"
          />
        ) : null}
        {contact.hot_flagged_at ? (
          <Star
            className="size-3.5 shrink-0 fill-amber-400 text-amber-400"
            aria-label="Flagged hot"
          />
        ) : null}
        <span className="truncate text-sm font-medium text-foreground">
          {displayName(contact)}
        </span>
        <LeadScoreBadge score={contact.lead_score} className="ml-auto" />
      </div>
      {preview ? (
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {preview.slice(0, 60)}
        </p>
      ) : null}
      <p className="mt-1 text-[10px] text-muted-foreground">
        {formatActivity(activityAt(contact))}
      </p>
    </div>
  );
}

function formatActivity(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "";
  }
}
