"use client";

import { Bot, Loader2, UserRound } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * Agent / human control toggle (Spec 6 C9).
 *
 * Maps 1:1 onto `contacts.human_controlled`, the hard database gate that
 * is checked FIRST on every inbound webhook (MEMORY read-first rule):
 *
 *   OFF (human_controlled = false) → the agent is handling this contact.
 *   ON  (human_controlled = true)  → the agent is paused; a human is on it.
 *
 * This component is *controlled* — it renders the current DB value and
 * calls `onChange` with the desired flag. It never writes to Postgres
 * itself, so the parent decides where/how to persist and can keep the
 * realtime-fed value as the single source of truth.
 *
 * While `pending` the switch is disabled and the label shows a spinner so
 * a slow round-trip can't be double-toggled into the wrong state.
 */

interface AgentToggleProps {
  /** Current value of contacts.human_controlled. */
  humanControlled: boolean;
  /** Desired value. Parent persists and (on success) updates its state. */
  onChange: (nextHumanControlled: boolean) => void;
  /** Round-trip in flight — disables the control. */
  pending?: boolean;
  /** Disable entirely (e.g. no write permission). */
  disabled?: boolean;
  className?: string;
  /** Hide the text label, leaving just the switch + icon. */
  compact?: boolean;
}

export function AgentToggle({
  humanControlled,
  onChange,
  pending = false,
  disabled = false,
  className,
  compact = false,
}: AgentToggleProps) {
  const Icon = humanControlled ? UserRound : Bot;
  const label = humanControlled ? "Human" : "Agent";

  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 select-none",
        (disabled || pending) && "cursor-not-allowed opacity-60",
        className,
      )}
      title={
        humanControlled
          ? "Agent paused — a human is handling this contact"
          : "Agent is handling this contact automatically"
      }
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Icon className="size-3.5" aria-hidden="true" />
        )}
        {!compact && label}
      </span>
      <Switch
        checked={humanControlled}
        disabled={disabled || pending}
        aria-label={
          humanControlled
            ? "Human control on — switch to let the agent respond"
            : "Agent control on — switch to take over as a human"
        }
        onCheckedChange={(checked) => onChange(checked)}
      />
    </label>
  );
}
