"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ConfigForm {
  client_brand_name: string;
  agent_persona_name: string;
  agent_tone: string;
  agent_language: string;
  agent_sign_off: string;
  escalation_phrase: string;
  wa_phone_number_id: string;
  notification_email: string;
  region_priority: string[];
}

const EMPTY: ConfigForm = {
  client_brand_name: "",
  agent_persona_name: "Sara",
  agent_tone: "professional_warm",
  agent_language: "en",
  agent_sign_off: "Best,",
  escalation_phrase: "Let me connect you with our senior advisor.",
  wa_phone_number_id: "",
  notification_email: "",
  region_priority: [],
};

const TONES = [
  { value: "professional_warm", label: "Professional, warm" },
  { value: "formal", label: "Formal" },
  { value: "friendly", label: "Friendly" },
  { value: "concise", label: "Concise" },
];

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "ar", label: "Arabic" },
  { value: "ru", label: "Russian" },
  { value: "zh", label: "Chinese" },
  { value: "hi", label: "Hindi" },
];

export default function SettingsPage() {
  const { accountId, canEditSettings, account } = useAuth();
  const [form, setForm] = useState<ConfigForm>(EMPTY);
  const [accessToken, setAccessToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [hasWebhookSecret, setHasWebhookSecret] = useState(false);
  const [newRegion, setNewRegion] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");

  useEffect(() => {
    setWebhookUrl(`${window.location.origin}/api/webhooks/whatsapp`);
  }, []);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const { data, error } = await supabase
      .from("client_config")
      .select(
        "client_brand_name, agent_persona_name, agent_tone, agent_language, agent_sign_off, escalation_phrase, wa_phone_number_id, wa_access_token, wa_webhook_secret, notification_email, region_priority",
      )
      .eq("client_id", accountId)
      .maybeSingle();
    if (error) {
      toast.error("Could not load settings", { description: error.message });
    } else if (data) {
      setForm({
        client_brand_name: data.client_brand_name ?? "",
        agent_persona_name: data.agent_persona_name ?? EMPTY.agent_persona_name,
        agent_tone: data.agent_tone ?? EMPTY.agent_tone,
        agent_language: data.agent_language ?? EMPTY.agent_language,
        agent_sign_off: data.agent_sign_off ?? EMPTY.agent_sign_off,
        escalation_phrase: data.escalation_phrase ?? EMPTY.escalation_phrase,
        wa_phone_number_id: data.wa_phone_number_id ?? "",
        notification_email: data.notification_email ?? "",
        region_priority: (data.region_priority as string[] | null) ?? [],
      });
      setHasToken(Boolean(data.wa_access_token));
      setHasWebhookSecret(Boolean(data.wa_webhook_secret));
    } else if (account?.name) {
      // No row yet — seed the brand from the client name so the required
      // NOT NULL column has a sane default on first save.
      setForm((f) => ({ ...f, client_brand_name: account.name }));
    }
    setLoading(false);
  }, [accountId, account?.name]);

  useEffect(() => {
    load();
  }, [load]);

  const set = useCallback(
    <K extends keyof ConfigForm>(key: K, value: ConfigForm[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
    },
    [],
  );

  const moveRegion = useCallback((index: number, dir: -1 | 1) => {
    setForm((f) => {
      const next = [...f.region_priority];
      const target = index + dir;
      if (target < 0 || target >= next.length) return f;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...f, region_priority: next };
    });
  }, []);

  const addRegion = useCallback(() => {
    const value = newRegion.trim().toUpperCase();
    if (!value) return;
    setForm((f) =>
      f.region_priority.includes(value)
        ? f
        : { ...f, region_priority: [...f.region_priority, value] },
    );
    setNewRegion("");
  }, [newRegion]);

  const disabled = !canEditSettings;

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/client-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          notification_email: form.notification_email.trim() || null,
          wa_phone_number_id: form.wa_phone_number_id.trim() || null,
          // Only send the token when the admin typed a replacement;
          // blank means "keep the stored ciphertext".
          wa_access_token: accessToken.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const p = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(p?.error ?? `Save failed (${res.status})`);
      }
      toast.success("Settings saved");
      if (accessToken.trim()) setHasToken(true);
      setAccessToken("");
    } catch (err) {
      toast.error("Could not save settings", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSaving(false);
    }
  }, [form, accessToken]);

  const canSave = useMemo(
    () => !disabled && form.client_brand_name.trim().length > 0,
    [disabled, form.client_brand_name],
  );

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      {disabled ? (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Only owners and admins can view or change settings.
        </div>
      ) : null}

      {/* 1. Agent persona */}
      <Card className="gap-3 p-4">
        <h2 className="text-sm font-semibold">Agent persona</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="persona">Persona name</Label>
          <Input
            id="persona"
            value={form.agent_persona_name}
            disabled={disabled}
            onChange={(e) => set("agent_persona_name", e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Tone</Label>
            <Select
              value={form.agent_tone}
              disabled={disabled}
              onValueChange={(v) => set("agent_tone", v as string)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TONES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Language</Label>
            <Select
              value={form.agent_language}
              disabled={disabled}
              onValueChange={(v) => set("agent_language", v as string)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="signoff">Sign-off</Label>
          <Input
            id="signoff"
            value={form.agent_sign_off}
            disabled={disabled}
            onChange={(e) => set("agent_sign_off", e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="escalation">Escalation phrase</Label>
          <Textarea
            id="escalation"
            value={form.escalation_phrase}
            disabled={disabled}
            rows={2}
            onChange={(e) => set("escalation_phrase", e.target.value)}
          />
        </div>
      </Card>

      {/* 2. Brand */}
      <Card className="gap-3 p-4">
        <h2 className="text-sm font-semibold">Brand</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brand">Company name</Label>
          <Input
            id="brand"
            value={form.client_brand_name}
            disabled={disabled}
            onChange={(e) => set("client_brand_name", e.target.value)}
          />
        </div>
      </Card>

      {/* 3. WhatsApp */}
      <Card className="gap-3 p-4">
        <h2 className="text-sm font-semibold">WhatsApp</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="phone-id">Phone number ID</Label>
          <Input
            id="phone-id"
            value={form.wa_phone_number_id}
            disabled={disabled}
            placeholder="From Meta Business dashboard"
            onChange={(e) => set("wa_phone_number_id", e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="token">Access token</Label>
          <Input
            id="token"
            type="password"
            value={accessToken}
            disabled={disabled}
            placeholder={hasToken ? "•••••••• (leave blank to keep)" : "Paste access token"}
            onChange={(e) => setAccessToken(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Stored encrypted. Leave blank to keep the current token.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Webhook URL</Label>
          <Input
            readOnly
            value={webhookUrl}
            className="font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          {hasWebhookSecret ? (
            <p className="text-xs text-emerald-600 dark:text-emerald-400">
              Webhook secret configured.
            </p>
          ) : null}
        </div>
      </Card>

      {/* 4. Notifications */}
      <Card className="gap-3 p-4">
        <h2 className="text-sm font-semibold">Notifications</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="notif-email">Hot-lead alert email</Label>
          <Input
            id="notif-email"
            type="email"
            value={form.notification_email}
            disabled={disabled}
            placeholder="alerts@yourcompany.com"
            onChange={(e) => set("notification_email", e.target.value)}
          />
        </div>
      </Card>

      {/* 5. Region priority */}
      <Card className="gap-3 p-4">
        <h2 className="text-sm font-semibold">Region priority</h2>
        <p className="text-xs text-muted-foreground">
          Order determines which region&apos;s listings the agent prefers.
        </p>
        <div className="flex flex-col gap-1.5">
          {form.region_priority.map((r, i) => (
            <div
              key={r}
              className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-sm"
            >
              <span className="flex-1 font-mono">{r}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Move ${r} up`}
                disabled={disabled || i === 0}
                onClick={() => moveRegion(i, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Move ${r} down`}
                disabled={disabled || i === form.region_priority.length - 1}
                onClick={() => moveRegion(i, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${r}`}
                disabled={disabled}
                onClick={() =>
                  set(
                    "region_priority",
                    form.region_priority.filter((x) => x !== r),
                  )
                }
              >
                <X />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Input
              value={newRegion}
              disabled={disabled}
              placeholder="e.g. AE"
              className="w-32"
              onChange={(e) => setNewRegion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addRegion();
                }
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !newRegion.trim()}
              onClick={addRegion}
            >
              <Plus /> Add
            </Button>
          </div>
        </div>
      </Card>

      <div className="flex justify-end pb-4">
        <Button onClick={save} disabled={!canSave || saving}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          Save changes
        </Button>
      </div>
    </div>
  );
}
