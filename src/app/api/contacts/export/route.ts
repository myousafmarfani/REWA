import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { generateContactsExport } from '@/lib/scoring/export';

const FORMATS = {
  csv: {
    content: 'text/csv; charset=utf-8',
    ext: 'csv',
  },
  xlsx: {
    content:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
  },
} as const;

/**
 * GET /api/contacts/export?format=xlsx — stream the continuous contacts
 * export (spec 5) as a download. RLS-scoped: the caller's own client
 * only, derived from the session — never from the query string.
 *
 * Same column contract as the daily scheduled export, so a client can
 * pull on demand between cron runs.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');

    const { searchParams } = new URL(request.url);
    const requested = searchParams.get('format')?.toLowerCase() ?? 'xlsx';
    if (requested !== 'csv' && requested !== 'xlsx') {
      return NextResponse.json(
        { error: `Unsupported format '${requested}'. Use csv or xlsx.` },
        { status: 400 }
      );
    }
    const format: 'csv' | 'xlsx' = requested;

    // ctx.accountId is the caller's client_id (profiles.account_id bridge).
    const buffer = await generateContactsExport({
      clientId: ctx.accountId,
      format,
    });

    const filename = `contacts-${new Date().toISOString().slice(0, 10)}.${FORMATS[format].ext}`;
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': FORMATS[format].content,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.byteLength),
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
