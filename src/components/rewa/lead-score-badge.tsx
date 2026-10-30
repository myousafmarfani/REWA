"use client";

import { Flame, Snowflake, Sun } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { LeadScore } from "@/lib/agent/types";

/**
 * Lead-score chip (Spec 6 C8). Colour is the load-bearing signal — at a
 * glance in the inbox / pipeline / contact rows a broker needs to know
 * how hot a lead is without reading the label.
 *
 *   hot  → rose   (act now)
 *   warm → amber  (nurture)
 *   cold → sky    (batch)
 *
 * `score` is typed as `LeadScore | string | null | undefined` on purpose:
 * the column is free `text` in Postgres (no CHECK), so legacy rows,
 * imports, or the agent can hand us anything. Anything we don't
 * recognise falls back to the cold treatment instead of throwing.
 */

interface ScoreVisual {
  label: string;
  icon: typeof Flame;
  className: string;
}

const SCORE_VISUALS: Record<LeadScore, ScoreVisual> = {
  hot: {
    label: "Hot",
    icon: Flame,
    className:
      "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  },
  warm: {
    label: "Warm",
    icon: Sun,
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  cold: {
    label: "Cold",
    icon: Snowflake,
    className:
      "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
};

function isLeadScore(value: unknown): value is LeadScore {
  return value === "hot" || value === "warm" || value === "cold";
}

interface LeadScoreBadgeProps {
  score: string | null | undefined;
  /** Hide the text and render only the glyph — for very tight rows. */
  iconOnly?: boolean;
  className?: string;
}

export function LeadScoreBadge({
  score,
  iconOnly = false,
  className,
}: LeadScoreBadgeProps) {
  const visual = isLeadScore(score) ? SCORE_VISUALS[score] : SCORE_VISUALS.cold;
  const Icon = visual.icon;

  return (
    <Badge
      variant="outline"
      className={cn("gap-1 font-medium capitalize", visual.className, className)}
      title={`${visual.label} lead`}
    >
      <Icon aria-hidden="true" />
      {iconOnly ? <span className="sr-only">{visual.label}</span> : visual.label}
    </Badge>
  );
}
