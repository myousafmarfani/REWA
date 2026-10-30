"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  isAccountRole,
  type AccountRole,
} from "@/lib/auth/roles";

/**
 * rewa user profile — backed by public.users (Spec 1 data model).
 *
 * The shape intentionally mirrors the old wacrm profile so the forked
 * shell keeps compiling, but the fields now resolve to rewa columns:
 *   users.id        → id
 *   users.full_name → full_name
 *   users.email     → email
 *   users.role      → role / account_role
 *   users.client_id → account_id
 * avatar_url / beta_features do not exist in rewa and are surfaced as
 * constants (null / []).
 */
interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  beta_features: string[];
  account_id: string | null;
  account_role: AccountRole | null;
}

interface AccountSummary {
  id: string;
  name: string;
  /**
   * rewa has no per-client currency column; pinned to DEFAULT_CURRENCY
   * so existing consumers (deals/settings) keep a defined value.
   */
  default_currency: string;
}

/**
 * Whether we managed to establish what this user may do.
 *
 * `unlinked` and `error` are the states worth surfacing: every RLS
 * policy checks `client_id = current_client_id()` and every `useCan`
 * gate returns false without a role, so in both the app silently
 * becomes read-only — the whole UI renders, and nothing saves. That is
 * indistinguishable from a bug unless we say so (issue #471).
 */
export type AccountStatus =
  /** Profile row still in flight. */
  | "loading"
  /** Client + role resolved; normal operation. */
  | "ready"
  /** Signed in, but no users row / no client / no role on it. */
  | "unlinked"
  /** The profile lookup itself failed after retrying. */
  | "error";

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  /**
   * Session-level loading. Flips to false as soon as we know whether
   * a user is signed in, *without* waiting for the profile row.
   */
  loading: boolean;
  /**
   * Profile-row loading. Stays true until `fetchProfile` settles
   * (success, missing row, or error).
   */
  profileLoading: boolean;
  signOut: () => Promise<void>;
  /** Re-fetch the current user's profile row — call after a save so
   *  header/sidebar reflect the change without a full page reload. */
  refreshProfile: () => Promise<void>;

  // ----------------------------------------------------------
  // Client-scoped context (rewa users/clients model)
  // ----------------------------------------------------------

  /** Outcome of resolving this user's client + role. */
  accountStatus: AccountStatus;
  /** Underlying message when `accountStatus` is 'error' / 'unlinked'. */
  accountStatusDetail: string | null;
  /** Client id the current user belongs to. Null while loading. */
  accountId: string | null;
  /** Role within that client. Null while loading. */
  accountRole: AccountRole | null;
  /** Lightweight client meta — id + name + default_currency. */
  account: AccountSummary | null;
  /** Client default deal currency. Falls back to DEFAULT_CURRENCY. */
  defaultCurrency: string;
  /** True if `accountRole === 'owner'`. */
  isOwner: boolean;
  /** True if `accountRole === 'admin'` (excludes owner). */
  isAdmin: boolean;
  /** True if `accountRole === 'agent'`. */
  isAgent: boolean;
  /** True if `accountRole === 'viewer'` (rewa never provisions it). */
  isViewer: boolean;
  /** True if the caller can manage members (admin+). */
  canManageMembers: boolean;
  /** True if the caller can edit client-wide settings (admin+). */
  canEditSettings: boolean;
  /** True if the caller can send messages / edit operational data (agent+). */
  canSendMessages: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Attempts at the profile lookup, including the first. */
const PROFILE_FETCH_ATTEMPTS = 2;
const PROFILE_FETCH_RETRY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shape of the `users` select below. */
interface UserRow {
  id: string;
  full_name: string | null;
  email: string;
  role: string | null;
  client_id: string | null;
}

/**
 * AuthProvider — wrap this around the dashboard layout.
 * Makes ONE getSession() call for the whole tree instead of one per
 * component, avoiding internal lock contention in the Supabase client.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // Why the client/role couldn't be established, when it couldn't.
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  // Tracked separately from `loading`. The session settles fast (one
  // local cookie read); the users fetch crosses the network and settles
  // later. Callers that gate on `profile.*` need to know which window.
  const [profileLoading, setProfileLoading] = useState(true);

  // Tracks the user ID we've successfully initiated/completed fetching
  // a profile for. Prevents redundant re-fetches and toggling
  // profileLoading back to true on window focus events/token refresh.
  const lastFetchedUserIdRef = useRef<string | null>(null);

  const fetchProfile = useCallback(async (userId: string) => {
    const supabase = createClient();
    setProfileLoading(true);
    setStatusDetail(null);
    lastFetchedUserIdRef.current = userId;
    try {
      let data: UserRow | null = null;
      for (let attempt = 1; ; attempt++) {
        const result = await supabase
          .from("users")
          .select("id, full_name, email, role, client_id")
          .eq("id", userId)
          .maybeSingle();

        if (!result.error) {
          data = result.data;
          break;
        }

        const error = result.error;
        console.error("[AuthProvider] fetchProfile error:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        // One hiccup here used to lock the session read-only for good.
        // Retry, then hand the reason to the UI.
        if (attempt < PROFILE_FETCH_ATTEMPTS) {
          await sleep(PROFILE_FETCH_RETRY_MS);
          continue;
        }
        lastFetchedUserIdRef.current = null;
        setStatusDetail(error.message);
        return;
      }

      if (data) {
        // Load the client with a plain lookup by id instead of an
        // embedded FK join. The embed (`client:clients!inner(...)`) forces
        // PostgREST to resolve users.client_id → clients.id from its
        // schema cache; a stale cache (common right after a migration
        // adds the FK) makes it fail hard with PGRST200 and blanks the
        // whole profile (issue #294). A point lookup by id needs no
        // relationship inference.
        let accountRow: AccountSummary | null = null;
        if (data.client_id) {
          const { data: client, error: clientErr } = await supabase
            .from("clients")
            .select("id, name")
            .eq("id", data.client_id)
            .maybeSingle();
          if (clientErr) {
            console.error("[AuthProvider] fetchClient error:", {
              message: clientErr.message,
              details: clientErr.details,
              hint: clientErr.hint,
              code: clientErr.code,
            });
          } else if (client) {
            accountRow = {
              id: client.id,
              name: client.name,
              default_currency: DEFAULT_CURRENCY,
            };
          }
        }

        // Narrow the text role into our AccountRole union. Fall back to
        // null and let UI gates treat the caller as least-privileged.
        const accountRole = isAccountRole(data.role) ? data.role : null;

        setProfile({
          id: data.id,
          full_name: data.full_name,
          email: data.email,
          avatar_url: null,
          role: data.role,
          beta_features: [],
          account_id: data.client_id ?? null,
          account_role: accountRole,
        });
        setAccount(accountRow);
        if (!data.client_id || !accountRole) {
          // The row exists but carries no tenancy. The handle_new_user
          // trigger roots new signups at the dev client, so this is a
          // user whose bootstrap didn't complete or one inserted by hand.
          // Every insert and update they attempt will be denied by RLS.
          setStatusDetail(
            `user ${data.id} has no ${!data.client_id ? "client_id" : "role"}`,
          );
        }
      } else {
        lastFetchedUserIdRef.current = null;
        setStatusDetail("no users row for the signed-in user");
      }
    } catch (err) {
      console.error("[AuthProvider] fetchProfile threw:", err);
      lastFetchedUserIdRef.current = null;
      setStatusDetail(err instanceof Error ? err.message : "profile fetch failed");
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;

    const safetyTimer = setTimeout(() => {
      if (mounted) {
        console.warn("[AuthProvider] getSession() timed out after 3s");
        setLoading(false);
        setProfileLoading(false);
      }
    }, 3000);

    const init = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (error) console.error("[AuthProvider] getSession error:", error.message);

        if (!mounted) return;
        const currentUser = session?.user ?? null;
        setUser(currentUser);

        if (currentUser) {
          // Don't block session loading on profile fetch — chrome
          // (header, sidebar) can render from the user object alone,
          // profile enriches async.
          fetchProfile(currentUser.id);
        } else {
          setProfileLoading(false);
        }
      } catch (err) {
        console.error("[AuthProvider] init threw:", err);
      } finally {
        if (mounted) setLoading(false);
        clearTimeout(safetyTimer);
      }
    };

    init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      const currentUser = session?.user ?? null;
      setUser(currentUser);

      if (currentUser) {
        if (currentUser.id !== lastFetchedUserIdRef.current) {
          fetchProfile(currentUser.id);
        }
      } else {
        lastFetchedUserIdRef.current = null;
        setProfile(null);
        setAccount(null);
        setProfileLoading(false);
      }

      setLoading(false);
    });

    return () => {
      mounted = false;
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  }, [fetchProfile]);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setAccount(null);
    window.location.href = "/login";
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!user?.id) return;
    await fetchProfile(user.id);
  }, [user?.id, fetchProfile]);

  // Derive the role booleans once per profile change.
  const derived = useMemo(() => {
    const role = profile?.account_role ?? null;
    return {
      accountRole: role,
      accountId: profile?.account_id ?? null,
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
    };
  }, [profile?.account_role, profile?.account_id]);

  // Signed out is not a broken account — the shell redirects to /login
  // before anything reads this.
  const accountStatus: AccountStatus = !user
    ? "loading"
    : profileLoading
      ? "loading"
      : !profile
        ? "error"
        : derived.accountId && derived.accountRole
          ? "ready"
          : "unlinked";

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        signOut,
        refreshProfile,
        account,
        defaultCurrency: account?.default_currency ?? DEFAULT_CURRENCY,
        accountStatus,
        accountStatusDetail: statusDetail,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * useAuth — read the shared auth state from context.
 * Must be used inside an <AuthProvider>.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider. Account
    // state collapses to least-privileged null — every `canX` boolean is
    // false so UI gates fail closed.
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      signOut: async () => {
        window.location.href = "/login";
      },
      refreshProfile: async () => {},
      account: null,
      defaultCurrency: DEFAULT_CURRENCY,
      accountStatus: "loading",
      accountStatusDetail: null,
      accountId: null,
      accountRole: null,
      isOwner: false,
      isAdmin: false,
      isAgent: false,
      isViewer: false,
      canManageMembers: false,
      canEditSettings: false,
      canSendMessages: false,
    };
  }
  return ctx;
}
