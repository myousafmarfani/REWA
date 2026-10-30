// ============================================================
// Role helpers — pure, unit-testable, no I/O.
//
// rewa's tenant model (Spec 1 data-model, MEMORY entries 3/6) stores the
// user's role as `public.users.role` — a text column, not a Postgres
// enum. rewa provisions three roles: owner, admin, agent. `viewer` is
// retained in this union only because the forked wacrm account-members UI
// still references the label; the rewa schema never writes it, and the
// predicates below treat it as read-only if it ever appears.
//
// The hierarchy is a flat ordinal (owner=4 … viewer=1). Predicates
// (`canManageMembers`, `canEditSettings`, …) are the single source of
// truth for "what can this role do?" — both API route guards and UI gates
// call them rather than open-coding role checks, so a role-policy change
// is a one-file diff.
//
// MEMORY (Spec 6 Layer B): `public.users` UPDATE is permitted by RLS for
// any member of the client, which means the database will allow a user to
// change their OWN role. The role checks here are therefore load-bearing
// on the app side — every privileged API route MUST gate through
// `requireRole()` from ./account, not rely on RLS alone.
// ============================================================

export type AccountRole = "owner" | "admin" | "agent" | "viewer";

/** Ordered list of every recognised role, lowest privilege first. */
export const ACCOUNT_ROLES: readonly AccountRole[] = [
  "viewer",
  "agent",
  "admin",
  "owner",
] as const;

/** The roles rewa actually provisions (see module header). */
export const REWA_ROLES: readonly AccountRole[] = [
  "owner",
  "admin",
  "agent",
] as const;

/**
 * Numeric rank of a role. Higher = more privileged.
 */
export function roleRank(role: AccountRole): number {
  switch (role) {
    case "owner":
      return 4;
    case "admin":
      return 3;
    case "agent":
      return 2;
    case "viewer":
      return 1;
  }
}

/**
 * True iff `role` is at least as privileged as `min`. Use this
 * for any "user has at least admin" / "at least agent" checks.
 */
export function hasMinRole(role: AccountRole, min: AccountRole): boolean {
  return roleRank(role) >= roleRank(min);
}

/** Type-narrow an unknown string into a valid `AccountRole`. */
export function isAccountRole(value: unknown): value is AccountRole {
  return (
    typeof value === "string" &&
    (ACCOUNT_ROLES as readonly string[]).includes(value)
  );
}

// ============================================================
// Capability predicates
//
// Every UI gate and API route guard calls one of these instead of
// comparing role strings inline. Adding a capability = one new
// predicate here + one call site change per consumer.
// ============================================================

/** Owner / admin: manage users, invite, remove, change roles. */
export function canManageMembers(role: AccountRole): boolean {
  return hasMinRole(role, "admin");
}

/**
 * Owner / admin: edit client-wide settings (client_config — agent
 * persona, WhatsApp credentials, region priority, notifications),
 * message templates, campaigns, property embeddings.
 */
export function canEditSettings(role: AccountRole): boolean {
  return hasMinRole(role, "admin");
}

/**
 * Owner / admin / agent: write operational data — read contacts,
 * read/write conversations and messages. An agent may NOT modify
 * client_config or campaigns (Spec 6 Layer B, task item 6).
 */
export function canSendMessages(role: AccountRole): boolean {
  return hasMinRole(role, "agent");
}

/**
 * Viewer: read-only across everything. rewa does not provision this
 * role; kept so the forked account UI's gate reads naturally.
 */
export function canViewOnly(role: AccountRole): boolean {
  return role === "viewer";
}

/** Owner only: irreversible destructive operations. */
export function canDeleteAccount(role: AccountRole): boolean {
  return role === "owner";
}

/** Owner only: hand the client to another member. */
export function canTransferOwnership(role: AccountRole): boolean {
  return role === "owner";
}
