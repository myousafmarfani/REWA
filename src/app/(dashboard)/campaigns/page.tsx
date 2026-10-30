"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Campaign {
  id: string;
  name: string;
  status: string;
  template_name: string | null;
  total_contacts: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
  paused_reason: string | null;
}

/** Status → badge treatment (Spec 6 C13). `running` gets the pulse dot. */
const STATUS_STYLES: Record<
  string,
  { label: string; className: string; pulse?: boolean }
> = {
  draft: { label: "Draft", className: "border-border bg-muted text-muted-foreground" },
  scheduled: { label: "Scheduled", className: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400" },
  running: { label: "Running", className: "border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400", pulse: true },
  paused: { label: "Paused", className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  completed: { label: "Completed", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  failed: { label: "Failed", className: "border-destructive/40 bg-destructive/10 text-destructive" },
};

export default function CampaignsPage() {
  const { canEditSettings } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("campaigns")
      .select(
        "id, name, status, template_name, total_contacts, sent_count, failed_count, created_at, paused_reason",
      )
      .order("created_at", { ascending: false });
    if (error) {
      toast.error("Could not load campaigns", { description: error.message });
    } else {
      setCampaigns((data as Campaign[]) ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const supabase = createClient();
    const channel = supabase
      .channel("campaigns-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "campaigns" },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  const startCampaign = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const res = await fetch(`/api/campaigns/${id}/start`, { method: "POST" });
        if (!res.ok) {
          const p = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(p?.error ?? `Failed (${res.status})`);
        }
        toast.success("Campaign started");
        load();
      } catch (err) {
        toast.error("Could not start campaign", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const pauseCampaign = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const res = await fetch(`/api/campaigns/${id}/pause`, { method: "POST" });
        if (!res.ok) {
          const p = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(p?.error ?? `Failed (${res.status})`);
        }
        toast.success("Campaign paused");
        load();
      } catch (err) {
        toast.error("Could not pause campaign", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const retryCampaign = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const res = await fetch(`/api/campaigns/${id}/retry`, { method: "POST" });
        if (!res.ok) {
          const p = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(p?.error ?? `Failed (${res.status})`);
        }
        toast.success("Campaign re-queued");
        load();
      } catch (err) {
        toast.error("Could not retry campaign", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const deleteCampaign = useCallback(
    async (id: string) => {
      setBusyId(id);
      const supabase = createClient();
      const { error } = await supabase.from("campaigns").delete().eq("id", id);
      if (error) {
        toast.error("Could not delete campaign", { description: error.message });
      } else {
        setCampaigns((prev) => prev.filter((c) => c.id !== id));
      }
      setBusyId(null);
    },
    [],
  );

  const empty = !loading && campaigns.length === 0;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Campaigns</h1>
        {canEditSettings ? (
          <Button nativeButton={false} render={<Link href="/campaigns/new" />}>
            <Plus /> New campaign
          </Button>
        ) : null}
      </div>

      {empty ? (
        <Card className="items-center gap-2 p-10 text-center">
          <p className="text-sm text-muted-foreground">No campaigns yet.</p>
          {canEditSettings ? (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link href="/campaigns/new" />}
            >
              <Plus /> Create your first campaign
            </Button>
          ) : null}
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground uppercase">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Template</th>
                <th className="px-3 py-2 font-medium">Contacts</th>
                <th className="px-3 py-2 font-medium">Sent</th>
                <th className="px-3 py-2 font-medium">Failed</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const style = STATUS_STYLES[c.status] ?? STATUS_STYLES.draft;
                const busy = busyId === c.id;
                return (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-3 py-2 font-medium">{c.name}</td>
                    <td className="px-3 py-2">
                      <StatusBadge style={style} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {c.template_name ?? "—"}
                    </td>
                    <td className="px-3 py-2">{c.total_contacts}</td>
                    <td className="px-3 py-2">{c.sent_count}</td>
                    <td className="px-3 py-2">{c.failed_count}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {timeAgo(c.created_at)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        {c.status === "draft" || c.status === "scheduled" ? (
                          <Button
                            size="xs"
                            disabled={busy || !canEditSettings}
                            onClick={() => startCampaign(c.id)}
                          >
                            Start
                          </Button>
                        ) : null}
                        {c.status === "paused" ? (
                          c.paused_reason === "quality" ? (
                            <span
                              className="text-xs text-amber-600 dark:text-amber-400"
                              title="Resumes automatically when the number rating recovers"
                            >
                              Quality hold
                            </span>
                          ) : (
                            <Button
                              size="xs"
                              disabled={busy || !canEditSettings}
                              onClick={() => startCampaign(c.id)}
                            >
                              Resume
                            </Button>
                          )
                        ) : null}
                        {c.status === "running" ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy || !canEditSettings}
                            onClick={() => pauseCampaign(c.id)}
                          >
                            Pause
                          </Button>
                        ) : null}
                        {c.status === "failed" ? (
                          <Button
                            size="xs"
                            disabled={busy || !canEditSettings}
                            onClick={() => retryCampaign(c.id)}
                          >
                            Retry
                          </Button>
                        ) : null}
                        {canEditSettings ? (
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label="Delete campaign"
                            disabled={busy}
                            onClick={() => deleteCampaign(c.id)}
                          >
                            <Trash2 />
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({
  style,
}: {
  style: { label: string; className: string; pulse?: boolean };
}) {
  return (
    <Badge variant="outline" className={cn("gap-1.5", style.className)}>
      {style.pulse ? (
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {style.label}
    </Badge>
  );
}

function timeAgo(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "";
  }
}
