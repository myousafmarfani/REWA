import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { encrypt } from "@/lib/whatsapp/encryption";

/**
 * PUT /api/client-config
 *
 * Upsert the calling client's `client_config` row. Server-side because
 * `wa_access_token` must be encrypted with ENCRYPTION_KEY before it
 * ever reaches Postgres — the sending/campaign tasks `decrypt()` it back
 * (src/lib/sending/index.ts), so storing plaintext (which a browser
 * upsert would do) would silently break every outbound send.
 *
 * Owner/admin only — mirrors the client_config RLS policy (Spec 6 C14).
 *
 * Body: the writable client_config columns. `wa_access_token` is
 * optional; when omitted or blank the existing ciphertext is preserved
 * (so the masked field can be left untouched). `wa_webhook_secret` is
 * never accepted from the client at all.
 */

interface ClientConfigBody {
  agent_persona_name?: string;
  agent_tone?: string;
  agent_language?: string;
  agent_sign_off?: string;
  escalation_phrase?: string;
  client_brand_name?: string;
  notification_email?: string | null;
  wa_phone_number_id?: string | null;
  wa_access_token?: string | null;
  region_priority?: string[];
}

export async function PUT(request: Request) {
  let ctx;
  try {
    ctx = await requireRole("admin");
  } catch (error) {
    return toErrorResponse(error);
  }
  const { supabase, accountId } = ctx;

  const body = (await request.json().catch(() => null)) as ClientConfigBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  if (
    body.client_brand_name !== undefined &&
    body.client_brand_name.trim() === ""
  ) {
    return NextResponse.json(
      { error: "Brand name is required" },
      { status: 400 },
    );
  }

  // Build an allowlisted patch. Columns NOT set by the caller are left
  // untouched on an existing row (PostgREST upsert sends only the keys we
  // include). client_brand_name is NOT NULL with no default, so on first
  // insert it must be present.
  const patch: Record<string, unknown> = {
    client_id: accountId,
    updated_at: new Date().toISOString(),
  };

  const passthrough: (keyof ClientConfigBody)[] = [
    "agent_persona_name",
    "agent_tone",
    "agent_language",
    "agent_sign_off",
    "escalation_phrase",
    "client_brand_name",
    "notification_email",
    "wa_phone_number_id",
    "region_priority",
  ];
  for (const key of passthrough) {
    if (body[key] !== undefined) patch[key] = body[key];
  }

  // Encrypt a newly-supplied access token; ignore blank so the masked
  // field can be submitted without clobbering the stored ciphertext.
  if (typeof body.wa_access_token === "string" && body.wa_access_token.trim()) {
    patch.wa_access_token = encrypt(body.wa_access_token.trim());
  }

  // First-time insert needs a brand name to satisfy NOT NULL.
  if (patch.client_brand_name === undefined) {
    const { data: existing } = await supabase
      .from("client_config")
      .select("client_id")
      .eq("client_id", accountId)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json(
        { error: "Brand name is required to create configuration" },
        { status: 400 },
      );
    }
  }

  const { error } = await supabase
    .from("client_config")
    .upsert(patch, { onConflict: "client_id" });

  if (error) {
    console.error("[client-config] upsert failed", { accountId, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
