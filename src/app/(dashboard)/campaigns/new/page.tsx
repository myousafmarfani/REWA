"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Template {
  id: string;
  name: string;
  language: string;
  body_text: string;
  category: string;
}

interface EligibleContact {
  id: string;
  full_name: string | null;
  phone_e164: string;
  lead_score: string;
  region: string | null;
}

const SCORE_FILTERS = [
  { value: "all", label: "All scores" },
  { value: "hot", label: "Hot only" },
  { value: "warm", label: "Warm only" },
  { value: "cold", label: "Cold only" },
];

/** Split a template body on {{n}} so variable slots can be highlighted. */
function renderTemplatePreview(body: string) {
  const parts = body.split(/(\{\{\d+\}\})/g);
  return parts.map((part, i) =>
    /^\{\{\d+\}\}$/.test(part) ? (
      <span
        key={i}
        className="rounded bg-primary/15 px-1 font-medium text-primary"
      >
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export default function NewCampaignPage() {
  const router = useRouter();
  const { accountId, user } = useAuth();

  const [name, setName] = useState("");
  const [score, setScore] = useState("all");
  const [region, setRegion] = useState("all");
  const [regions, setRegions] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [contacts, setContacts] = useState<EligibleContact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const loadContacts = useCallback(async () => {
    const supabase = createClient();
    // Base eligibility per spec: status = 'clean', number_type = 'mobile',
    // not opted out. Score/region are applied client-side so switching the
    // filter doesn't re-hit the network.
    const { data, error } = await supabase
      .from("contacts")
      .select("id, full_name, phone_e164, lead_score, region")
      .eq("status", "clean")
      .eq("opted_out", false)
      .eq("number_type", "mobile");
    if (error) {
      toast.error("Could not load contacts", { description: error.message });
    } else {
      const rows = (data as EligibleContact[]) ?? [];
      setContacts(rows);
      setRegions(
        Array.from(new Set(rows.map((r) => r.region).filter(Boolean) as string[])).sort(),
      );
    }
    setLoadingContacts(false);
  }, []);

  const loadTemplates = useCallback(async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("message_templates")
      .select("id, name, language, body_text, category")
      .eq("status", "approved")
      .order("name", { ascending: true });
    if (error) {
      toast.error("Could not load templates", { description: error.message });
    } else {
      const rows = (data as Template[]) ?? [];
      setTemplates(rows);
      if (rows[0]) setTemplateId(rows[0].id);
    }
  }, []);

  useEffect(() => {
    loadContacts();
    loadTemplates();
  }, [loadContacts, loadTemplates]);

  const filtered = useMemo(
    () =>
      contacts.filter(
        (c) =>
          (score === "all" || c.lead_score === score) &&
          (region === "all" || c.region === region),
      ),
    [contacts, score, region],
  );

  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;

  const handleSubmit = useCallback(async () => {
    if (!accountId) {
      toast.error("Your account is not ready yet");
      return;
    }
    if (!name.trim()) {
      toast.error("Give the campaign a name");
      return;
    }
    if (!selectedTemplate) {
      toast.error("Choose an approved template");
      return;
    }
    if (filtered.length === 0) {
      toast.error("No eligible contacts match these filters");
      return;
    }
    if (mode === "schedule" && !scheduledAt) {
      toast.error("Pick a date and time to schedule");
      return;
    }

    setSubmitting(true);
    const supabase = createClient();
    try {
      const isScheduled = mode === "schedule";
      const { data: campaign, error: campaignError } = await supabase
        .from("campaigns")
        .insert({
          client_id: accountId,
          name: name.trim(),
          status: isScheduled ? "scheduled" : "draft",
          template_id: selectedTemplate.id,
          template_name: selectedTemplate.name,
          total_contacts: filtered.length,
          created_by: user?.id ?? null,
          scheduled_at: isScheduled
            ? new Date(scheduledAt).toISOString()
            : null,
        })
        .select("id")
        .single();
      if (campaignError || !campaign) {
        throw new Error(campaignError?.message ?? "Could not create campaign");
      }

      const { error: ccError } = await supabase
        .from("campaign_contacts")
        .insert(
          filtered.map((c) => ({
            campaign_id: campaign.id,
            contact_id: c.id,
            client_id: accountId,
            status: "pending" as const,
          })),
        );
      if (ccError) throw new Error(ccError.message);

      if (!isScheduled) {
        const res = await fetch(`/api/campaigns/${campaign.id}/start`, {
          method: "POST",
        });
        if (!res.ok) {
          const p = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(p?.error ?? `Failed to start (${res.status})`);
        }
      }

      toast.success(
        isScheduled ? "Campaign scheduled" : "Campaign started",
      );
      router.push("/campaigns");
    } catch (err) {
      toast.error("Could not create campaign", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    accountId,
    name,
    selectedTemplate,
    filtered,
    mode,
    scheduledAt,
    user?.id,
    router,
  ]);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="mb-4 flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          nativeButton={false}
          render={<a href="/campaigns" />}
        >
          <ArrowLeft />
        </Button>
        <h1 className="text-lg font-semibold">New campaign</h1>
      </div>

      <div className="flex flex-col gap-4">
        {/* Step 1 — name + audience */}
        <Card className="gap-3 p-4">
          <h2 className="text-sm font-semibold">1. Name &amp; audience</h2>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="campaign-name">Campaign name</Label>
            <Input
              id="campaign-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Marina launch — warm leads"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Score</Label>
              <Select value={score} onValueChange={(v) => setScore(v as string)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCORE_FILTERS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Region</Label>
              <Select value={region} onValueChange={(v) => setRegion(v as string)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All regions</SelectItem>
                  {regions.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            {loadingContacts ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            <span className="text-muted-foreground">
              <span className="font-semibold text-foreground">
                {filtered.length}
              </span>{" "}
              eligible contact{filtered.length === 1 ? "" : "s"} match
            </span>
          </div>
        </Card>

        {/* Step 2 — template */}
        <Card className="gap-3 p-4">
          <h2 className="text-sm font-semibold">2. Template</h2>
          {templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No approved templates yet. Sync templates before sending a
              campaign.
            </p>
          ) : (
            <>
              <Select
                value={templateId}
                onValueChange={(v) => setTemplateId(v as string)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} · {t.language}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedTemplate ? (
                <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
                  {renderTemplatePreview(selectedTemplate.body_text)}
                </div>
              ) : null}
            </>
          )}
        </Card>

        {/* Step 3 — schedule */}
        <Card className="gap-3 p-4">
          <h2 className="text-sm font-semibold">3. Send</h2>
          <div className="flex gap-2">
            <Button
              variant={mode === "now" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("now")}
            >
              Send now
            </Button>
            <Button
              variant={mode === "schedule" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("schedule")}
            >
              Schedule
            </Button>
          </div>
          {mode === "schedule" ? (
            <Input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          ) : null}
        </Card>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => router.push("/campaigns")}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? <Loader2 className="animate-spin" /> : null}
            {mode === "now" ? "Create & send" : "Create & schedule"}
          </Button>
        </div>
      </div>
    </div>
  );
}
