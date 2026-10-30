import { afterEach, describe, expect, it, vi } from "vitest";

// getCurrentAccount resolves the caller's tenant context from the rewa
// tables (public.users → public.clients). The regression this file
// guards (issue #294): account loading must NOT depend on a PostgREST
// embedded FK join (`clients!inner`), because a stale schema cache makes
// that embed fail hard and blanks the whole context. It must instead
// read the users row, then the client, with two plain point queries.

// ------------------------------------------------------------
// Chainable Supabase query-builder mock. Each `.from(table)` hands back
// a thenable builder pre-loaded with the result queued for that table,
// so we can assert which tables were queried and with what filters.
// ------------------------------------------------------------
interface BuilderCall {
  table: string;
  columns?: string;
  eqArgs: [string, unknown][];
}

function makeClient(opts: {
  user: { id: string } | null;
  userErr?: unknown;
  byTable: Record<string, { data: unknown; error: unknown }>;
}) {
  const calls: BuilderCall[] = [];

  const from = (table: string) => {
    const call: BuilderCall = { table, eqArgs: [] };
    calls.push(call);
    const builder = {
      select(columns: string) {
        call.columns = columns;
        return builder;
      },
      eq(col: string, val: unknown) {
        call.eqArgs.push([col, val]);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve(
          opts.byTable[table] ?? { data: null, error: null },
        );
      },
    };
    return builder;
  };

  return {
    calls,
    client: {
      auth: {
        getUser: () =>
          Promise.resolve({
            data: { user: opts.user },
            error: opts.userErr ?? null,
          }),
      },
      from,
    },
  };
}

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => createClient(),
}));

const { getCurrentAccount, requireRole, UnauthorizedError, ForbiddenError } =
  await import("./account");

afterEach(() => {
  vi.clearAllMocks();
});

describe("getCurrentAccount", () => {
  it("resolves context via plain users + clients lookups, not an embedded join", async () => {
    const { client, calls } = makeClient({
      user: { id: "user-1" },
      byTable: {
        users: { data: { client_id: "acct-1", role: "owner" }, error: null },
        clients: { data: { id: "acct-1", name: "Acme" }, error: null },
      },
    });
    createClient.mockReturnValue(client);

    const ctx = await getCurrentAccount();

    expect(ctx).toMatchObject({
      userId: "user-1",
      accountId: "acct-1",
      role: "owner",
      account: { id: "acct-1", name: "Acme" },
    });

    // Two queries: users by id, then clients by id. Neither selects an
    // embedded relationship — the regression guard.
    expect(calls.map((c) => c.table)).toEqual(["users", "clients"]);
    expect(calls[0].columns).not.toMatch(/clients!/);
    expect(calls[0].eqArgs).toEqual([["id", "user-1"]]);
    expect(calls[1].columns).not.toMatch(/clients!/);
    expect(calls[1].eqArgs).toEqual([["id", "acct-1"]]);
  });

  it("throws UnauthorizedError when there is no session", async () => {
    const { client } = makeClient({ user: null, byTable: {} });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("maps a users query error to 'Could not load account context'", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        users: { data: null, error: { code: "PGRST200" } },
      },
    });
    createClient.mockReturnValue(client);
    const err = await getCurrentAccount().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe("Could not load account context");
  });

  it("maps a clients query error to 'Could not load account context'", async () => {
    // The exact #294 shape if the embed were still in play, but now on
    // the decoupled clients lookup: users resolves, client read errors.
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        users: { data: { client_id: "acct-1", role: "admin" }, error: null },
        clients: { data: null, error: { code: "PGRST200" } },
      },
    });
    createClient.mockReturnValue(client);
    const err = await getCurrentAccount().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe("Could not load account context");
  });

  it("rejects a users row not linked to a client", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        users: { data: { client_id: null, role: null }, error: null },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "User is not linked to a client",
    );
  });

  it("rejects a client_id that resolves to no readable client", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        users: { data: { client_id: "acct-1", role: "agent" }, error: null },
        clients: { data: null, error: null },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "User is not linked to a client",
    );
  });

  it("rejects an unrecognized role value", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        users: { data: { client_id: "acct-1", role: "superuser" }, error: null },
      },
    });
    createClient.mockReturnValue(client);
    const err = await getCurrentAccount().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe("Unknown role: superuser");
  });
});

describe("requireRole", () => {
  it("returns the context when the caller meets the minimum role", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        users: { data: { client_id: "acct-1", role: "admin" }, error: null },
        clients: { data: { id: "acct-1", name: "Acme" }, error: null },
      },
    });
    createClient.mockReturnValue(client);
    const ctx = await requireRole("agent");
    expect(ctx.role).toBe("admin");
  });

  it("throws ForbiddenError when the caller is below the minimum role", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        users: { data: { client_id: "acct-1", role: "agent" }, error: null },
        clients: { data: { id: "acct-1", name: "Acme" }, error: null },
      },
    });
    createClient.mockReturnValue(client);
    const err = await requireRole("admin").catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toContain("'admin' role");
  });
});
