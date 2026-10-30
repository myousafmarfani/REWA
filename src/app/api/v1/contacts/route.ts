// ============================================================
// GET  /api/v1/contacts  — list contacts (scope: contacts:read)
// POST /api/v1/contacts  — create a contact  (scope: contacts:write)
//
// List is keyset-paginated (see src/lib/api/v1/pagination.ts) and
// supports `?search=` (name/phone). Create is find-or-create by phone:
// an existing match returns 200 with `created: false`; a new row returns
// 201 with `created: true`.
//
// rewa schema (MEMORY.md entry 19): rows are scoped by `client_id`
// (what `ctx.accountId` carries here), searched on `full_name` /
// `phone_e164`. The retired wacrm `tags` / `company` fields are
// rejected explicitly rather than silently ignored.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import {
  CONTACT_SELECT,
  serializeContact,
  findOrCreateContact,
  getContactById,
  ContactError,
} from '@/lib/api/v1/contacts';

// PostgREST filter values are comma/paren-delimited; strip anything
// that could break the `.or()` grammar before interpolating a search
// term. Leaves the characters a phone or name legitimately contains.
function sanitizeSearch(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} +@.\-_]/gu, '').trim();
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const search = sanitizeSearch(url.searchParams.get('search') ?? '');

    // `tags`/`contact_tags` are retired wacrm tables (MEMORY.md 19) —
    // reject the filter instead of returning an unfiltered page.
    if (url.searchParams.has('tag')) {
      return fail('bad_request', "'tag' filter is not supported", 400);
    }

    let query = ctx.supabase
      .from('contacts')
      .select(CONTACT_SELECT)
      .eq('client_id', ctx.accountId);

    if (search) {
      query = query.or(
        `full_name.ilike.*${search}*,phone_e164.ilike.*${search}*`
      );
    }

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/contacts] list error:', error);
      return fail('internal', 'Failed to list contacts', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((r) => serializeContact(r as Record<string, unknown>)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    // Rejected BEFORE any write so a rejected request never creates a row.
    if ('tags' in body || 'company' in body) {
      return fail('bad_request', "'tags' and 'company' are not supported", 400);
    }

    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!phone) {
      return fail('bad_request', "'phone' is required", 400);
    }

    const { id, created } = await findOrCreateContact(
      ctx.supabase,
      ctx.accountId,
      {
        phone,
        name: typeof body.name === 'string' ? body.name : undefined,
        email: typeof body.email === 'string' ? body.email : undefined,
      }
    );

    const contact = await getContactById(ctx.supabase, ctx.accountId, id);
    return ok(contact, created ? 201 : 200);
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
