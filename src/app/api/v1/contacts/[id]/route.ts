// ============================================================
// GET   /api/v1/contacts/{id} — read a contact  (scope contacts:read)
// PATCH /api/v1/contacts/{id} — update a contact (scope contacts:write)
//
// Both are client-scoped: a contact belonging to another client returns
// 404 (never 403 — don't reveal it exists elsewhere).
//
// rewa schema (MEMORY.md entry 19): the request field `name` maps onto
// `contacts.full_name`, rows are scoped by `client_id`, and the retired
// wacrm `company` / `tags` fields are rejected rather than silently
// ignored. PATCH updates only the fields present in the body.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { getContactById, ContactError } from '@/lib/api/v1/contacts';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read');
    const { id } = await params;
    const contact = await getContactById(ctx.supabase, ctx.accountId, id);
    if (!contact) return fail('not_found', 'Contact not found', 404);
    return ok(contact);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    // Retired wacrm fields — surface the rejection instead of silently
    // dropping the caller's intended write.
    for (const retired of ['company', 'tags'] as const) {
      if (retired in body) {
        return fail('bad_request', `'${retired}' is not supported`, 400);
      }
    }

    // Verify the contact is in this client before mutating anything.
    const existing = await getContactById(ctx.supabase, ctx.accountId, id);
    if (!existing) return fail('not_found', 'Contact not found', 404);

    // Build a partial update from the provided scalar fields. A field
    // is updated only when its key is PRESENT (so omitted fields are
    // untouched); `null` clears it, a string sets it, and any other
    // type is a 400 rather than a silently-ignored no-op.
    const updates: Record<string, unknown> = {};
    const fields = [['name', 'full_name'], ['email', 'email']] as const;
    for (const [requestField, column] of fields) {
      if (!(requestField in body)) continue;
      const value = body[requestField];
      if (value === null || typeof value === 'string') {
        updates[column] = value;
      } else {
        return fail(
          'bad_request',
          `'${requestField}' must be a string or null`,
          400
        );
      }
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { error } = await ctx.supabase
        .from('contacts')
        .update(updates)
        .eq('id', id)
        .eq('client_id', ctx.accountId);
      if (error) {
        console.error('[api/v1/contacts] update error:', error);
        return fail('internal', 'Failed to update contact', 500);
      }
    }

    const contact = await getContactById(ctx.supabase, ctx.accountId, id);
    return ok(contact);
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(err.status === 400 ? 'bad_request' : 'internal', err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
