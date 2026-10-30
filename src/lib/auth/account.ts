// ============================================================
// Server-side auth context — for API routes and server components.
// Reads the caller's row from public.users and their tenant from
// public.clients, then verifies role on demand.
//
// IMPORTANT: this module is server-only. It imports the Supabase
// SSR client (`@/lib/supabase/server`), which reads `next/headers`
// cookies. Importing it from a client component will fail at
// build time with the standard Next.js "You're importing a
// component that needs `next/headers`" error — that's the
// boundary check; we don't need the `server-only` package.
//
// rewa mapping (Spec 6 Layer B — replaces the profiles/accounts
// bridge views):
//   users.id        → auth.uid()
//   users.client_id → tenant id (RLS `current_client_id()`)
//   users.role      → owner | admin | agent
//   clients.name    → tenant display name
//
// Calling convention
// ------------------
// API routes don't need to redo `supabase.auth.getUser()` — they
// receive a fully-loaded context from `requireRole`:
//
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.supabase — the SSR client (RLS scoped to this user)
//     // ctx.userId  — auth.uid()
//     // ctx.accountId / ctx.role / ctx.account
//   } catch (err) {
//     return toErrorResponse(err); // see toErrorResponse() below
//   }
//
// Why app-side gates are load-bearing: `public.users` UPDATE is allowed
// by RLS for any member of the client, so the database does NOT prevent a
// user from promoting themself. `requireRole` is the real boundary.
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";

// ------------------------------------------------------------
// Errors
//
// Custom classes so API routes can map a single `catch` to the
// right HTTP status without sprinkling 401/403 strings everywhere.
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Convert one of the typed errors above (or anything else) into a
 * `NextResponse`. Routes can do:
 *
 *   } catch (err) {
 *     return toErrorResponse(err);
 *   }
 *
 * Unknown errors collapse to 500 with the generic message — we
 * never leak `err.message` for non-classified errors to keep
 * server internals out of the wire.
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** Supabase SSR client, RLS scoped to the calling user. */
  supabase: SupabaseClient;
  /** `auth.uid()` for the caller. Always defined when this resolves. */
  userId: string;
  /** Caller's client_id from their users row. */
  accountId: string;
  /** Caller's role within their client. */
  role: AccountRole;
  /** Lightweight tenant meta — id + name. */
  account: { id: string; name: string };
}

/**
 * Resolve the caller's user + client + role.
 *
 * Throws `UnauthorizedError` if there's no Supabase session.
 * Throws `ForbiddenError` if the users row is missing / unlinked
 * (shouldn't happen with the handle_new_user trigger; defensive
 * guard against a row that predates it or was inserted by hand).
 *
 * Use `requireRole(min)` instead when the route also needs a
 * minimum-role check — it's a thin wrapper over this.
 */
export async function getCurrentAccount(): Promise<AccountContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new UnauthorizedError();
  }

  const { data, error } = await supabase
    .from("users")
    .select("client_id, role")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[getCurrentAccount] users fetch error:", error);
    throw new ForbiddenError("Could not load account context");
  }
  if (!data || !data.client_id || !data.role) {
    throw new ForbiddenError("User is not linked to a client");
  }
  if (!isAccountRole(data.role)) {
    // Text column, no DB enum to fall back on — a hand-edited or
    // forward-written value would land here. Surface rather than
    // silently widening.
    throw new ForbiddenError(`Unknown role: ${data.role}`);
  }

  // Point lookup by id rather than an embedded FK join. The embed forces
  // PostgREST to resolve users.client_id → clients.id from its schema
  // cache; a stale cache (common right after a migration adds the FK)
  // fails hard with PGRST200 and takes down the whole context. A lookup
  // by id needs no relationship inference and is gated by clients RLS.
  const { data: account, error: accountErr } = await supabase
    .from("clients")
    .select("id, name")
    .eq("id", data.client_id)
    .maybeSingle();

  if (accountErr) {
    console.error("[getCurrentAccount] clients fetch error:", accountErr);
    throw new ForbiddenError("Could not load account context");
  }
  if (!account) {
    throw new ForbiddenError("User is not linked to a client");
  }

  return {
    supabase,
    userId: user.id,
    accountId: data.client_id,
    role: data.role,
    account: { id: account.id, name: account.name },
  };
}

/**
 * Resolve the caller's account context and enforce a minimum role.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError("Insufficient role")`
 * when the caller is below `min`.
 */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`,
    );
  }
  return ctx;
}
