import * as XLSX from 'xlsx';

import type { ParsedContact } from './types';

// Case-insensitive, whitespace-trimmed header aliases (spec loader.ts).
const PHONE_ALIASES: string[] = [
  'phone',
  'mobile',
  'number',
  'contact',
  'whatsapp',
  'tel',
  'telephone',
  'cell',
  'phone_number',
  'mobile_number',
  'contact_number',
  'whatsapp_number',
];

const NAME_ALIASES: string[] = [
  'name',
  'full_name',
  'fullname',
  'contact_name',
  'client_name',
  'lead_name',
  'first_name',
  'last_name',
];

const EMAIL_ALIASES: string[] = ['email', 'email_address', 'mail', 'e-mail'];

export interface ParsedFile {
  rows: ParsedContact[];
  phoneIndex: number;
  nameIndex: number | null;
  emailIndex: number | null;
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return String(value);
  }
  return String(value).trim();
}

// Phone cells: strip the Excel float suffix ('.0'), not the scientific
// re-hydration — that happens in normaliser so the stored best-effort
// invalid key is the post-.0-strip string per spec.
function phoneCellToString(value: unknown): string {
  return cellToString(value).replace(/\.0+$/, '');
}

/**
 * Parse an uploaded .xlsx/.xls/.csv into ParsedContact rows. Column
 * detection: lowercase + trim each header, first alias match wins.
 * Fails with the detected columns listed when no phone column exists.
 */
export function parseContactFile(
  buffer: ArrayBuffer,
  _filename: string,
): ParsedFile {
  // `filename` is signature parity with the spec; SheetJS sniffs the
  // format (.xlsx/.xls/.csv) from the buffer content, not the name.
  void _filename;
  const workbook = XLSX.read(buffer, { type: 'array', raw: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('No worksheets found in the file');

  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: true,
  }) as unknown[][];

  const headers = aoa.length > 0 ? (aoa[0] ?? []).map(cellToString) : [];
  // Headers and aliases are compared with spaces/underscores/hyphens
  // stripped, so spec aliases (phone_number, first_name, e-mail) also
  // match their real-world space variants (Phone Number, First Name,
  // E-Mail) exactly as the original Python pipeline did.
  const normalize = (s: string): string => s.toLowerCase().replace(/[\s_-]/g, '');
  const normalized = headers.map(normalize);

  const phoneIndex = normalized.findIndex((h) => PHONE_ALIASES.some((a) => normalize(a) === h));
  if (phoneIndex === -1) {
    throw new Error(
      `No phone column found. Detected columns: ${headers.filter(Boolean).join(', ')}`,
    );
  }
  const nameIndex = normalized.findIndex((h) => NAME_ALIASES.some((a) => normalize(a) === h));
  const emailIndex = normalized.findIndex((h) => EMAIL_ALIASES.some((a) => normalize(a) === h));

  const rows: ParsedContact[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const line: unknown[] = aoa[i] ?? [];
    const raw: Record<string, unknown> = {};
    headers.forEach((header, idx) => {
      if (!header) return;
      const value = line[idx];
      raw[header] = value ?? null;
    });

    rows.push({
      rawPhone: phoneCellToString(line[phoneIndex]),
      rawName: nameIndex === -1 ? null : cellToString(line[nameIndex]) || null,
      rawEmail:
        emailIndex === -1 ? null : cellToString(line[emailIndex]) || null,
      rowIndex: i - 1,
      raw,
    });
  }
  return { rows, phoneIndex, nameIndex, emailIndex };
}