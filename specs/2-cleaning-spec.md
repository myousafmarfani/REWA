# Spec 2: Contact Cleaning Pipeline
# Project: rewa
# depends_on: 1-data-model-spec (contacts, contact_imports tables must exist)
# subagents: @domain-strategist (review) → @backend-builder (implement) → @qa-reviewer (verify)
# mcps: supabase (write contacts + contact_imports), context7 (libphonenumber-js docs)

---

## Purpose

Port the entire contact cleaning logic from the original Python pipeline
(dubai-re-outreach/cleaner/) into TypeScript. The logic must be
identical — same edge cases, same output categories, same validation
rules. The output is rows in the contacts table, not files.

Read the contact-cleaning-rules skill before implementing anything.

---

## Constraints from MEMORY.md

- Entry 5: TypeScript only, no Python.
- Entry 7: All Python edge cases preserved exactly. Region priority is
  per-client config, not hardcoded.
- Entry 5: Supabase is the output target — not Excel files.
- Entry 15: $0 cost — libphonenumber-js is free/MIT.

---

## Module location

```
src/
  lib/
    cleaning/
      index.ts          -- main entry point, orchestrates the pipeline
      loader.ts         -- parse uploaded file, detect columns
      normaliser.ts     -- E.164 normalisation via libphonenumber-js
      deduplicator.ts   -- exact + near-duplicate detection
      classifier.ts     -- number type, region, carrier, email type
      sorter.ts         -- priority rank assignment per client config
      importer.ts       -- write results to Supabase contacts table
      types.ts          -- shared TypeScript types for this module
```

---

## Dependencies

```bash
npm install libphonenumber-js xlsx
npm install --save-dev @types/node
```

- `libphonenumber-js` — phone normalisation, type detection, region
- `xlsx` (SheetJS) — Excel/CSV parsing (already in wacrm fork likely)

---

## Types (types.ts)

```typescript
export type CleaningStatus = 'clean' | 'invalid' | 'review' | 'duplicate';
export type InvalidReason = 'empty' | 'too_short' | 'parse_failed' | 'invalid_region';
export type NumberType = 'mobile' | 'landline' | 'voip' | 'unknown';
export type EmailType = 'personal' | 'business' | 'generic' | 'invalid';

export interface RawRow {
  raw: Record<string, unknown>;   // original row from file
  rowIndex: number;
}

export interface ParsedContact {
  rawPhone: string;
  rawName: string | null;
  rawEmail: string | null;
  rowIndex: number;
  raw: Record<string, unknown>;
}

export interface CleanedContact {
  phoneE164: string | null;
  fullName: string | null;
  email: string | null;
  emailType: EmailType | null;
  status: CleaningStatus;
  invalidReason: InvalidReason | null;
  numberType: NumberType;
  region: string | null;
  carrier: string | null;
  isPremium: boolean;
  priorityRank: number | null;
  rawImport: Record<string, unknown>;
}

export interface CleaningResult {
  clean: CleanedContact[];
  invalid: CleanedContact[];
  review: CleanedContact[];         // near-duplicates
  duplicate: CleanedContact[];      // exact duplicates
  importId: string;
}
```

---

## loader.ts — column detection + file parsing

```typescript
// Recognised phone column aliases (case-insensitive match)
const PHONE_ALIASES = [
  'phone', 'mobile', 'number', 'contact', 'whatsapp', 'tel',
  'telephone', 'cell', 'phone_number', 'mobile_number',
  'contact_number', 'whatsapp_number'
];

// Recognised name column aliases
const NAME_ALIASES = [
  'name', 'full_name', 'fullname', 'contact_name', 'client_name',
  'lead_name', 'first_name', 'last_name'
];

// Recognised email column aliases
const EMAIL_ALIASES = [
  'email', 'email_address', 'mail', 'e-mail'
];
```

Column detection logic:
1. Read the header row of the uploaded file.
2. For each header, lowercase and strip whitespace.
3. Match against PHONE_ALIASES, NAME_ALIASES, EMAIL_ALIASES.
4. If no phone column is found: throw an error listing the detected
   column names so the user can rename their header.
5. If multiple phone-like columns found: pick the first match.

File formats supported: .xlsx, .xls, .csv. Use SheetJS for all three.

Excel float handling (CRITICAL — from real production data):
- Numeric cells that look like phone numbers arrive as floats:
  e.g. 971501234567.0 or 9.71501234567e11
- Before passing to libphonenumber-js, convert to string and strip
  trailing .0 (regex: `/\.0+$/`)
- Never call .toString() on a float directly without this step

---

## normaliser.ts — E.164 normalisation

```typescript
import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js';

function normalise(raw: string, defaultCountry: string): {
  e164: string | null;
  reason: InvalidReason | null;
} {
  // 1. Empty check
  if (!raw || raw.trim() === '') {
    return { e164: null, reason: 'empty' };
  }

  // 2. Strip Excel float suffix
  const cleaned = raw.toString().replace(/\.0+$/, '').trim();

  // 3. Minimum length check (7 digits after stripping non-numeric)
  const digitsOnly = cleaned.replace(/\D/g, '');
  if (digitsOnly.length < 7) {
    return { e164: null, reason: 'too_short' };
  }

  // 4. Attempt parse with libphonenumber-js
  try {
    const parsed = parsePhoneNumber(cleaned, defaultCountry as any);
    if (!parsed || !parsed.isValid()) {
      return { e164: null, reason: 'parse_failed' };
    }
    return { e164: parsed.format('E.164'), reason: null };
  } catch {
    return { e164: null, reason: 'parse_failed' };
  }
}
```

The `defaultCountry` is read from `client_config.region_priority[0]`
mapped to ISO2 code — not hardcoded.

---

## deduplicator.ts — exact + near-duplicate detection

```typescript
// Exact duplicate: same E.164 value
// Keep first occurrence. Mark subsequent as status = 'duplicate'.

// Near-duplicate: first 10 digits of E.164 match but full number differs
// Example: +971501234567 vs +971501234568 (trailing digit typo)
// Do NOT auto-merge. Mark as status = 'review'.

function deduplicateContacts(contacts: ParsedContactWithE164[]): {
  clean: ParsedContactWithE164[];
  duplicates: ParsedContactWithE164[];
  reviews: ParsedContactWithE164[];
} {
  const seenE164 = new Map<string, number>();     // e164 → first row index
  const seenPrefix = new Map<string, string>();   // first10digits → first e164

  // Process in row order (first occurrence wins)
  // For each contact with a valid e164:
  //   1. Check exact match in seenE164 → mark duplicate
  //   2. Check first-10-digit prefix in seenPrefix → mark review
  //   3. Otherwise → clean, register in both maps
}
```

---

## classifier.ts — number type, region, email type

Number classification (after E.164 normalisation):
```typescript
import { parsePhoneNumber, getNumberType } from 'libphonenumber-js';

// getNumberType returns: MOBILE, FIXED_LINE, VOIP, PREMIUM_RATE, etc.
// Map to rewa's types:
// MOBILE → 'mobile'
// FIXED_LINE | FIXED_LINE_OR_MOBILE → 'landline'
// VOIP → 'voip'
// everything else → 'unknown'

// Region: parsed.country from libphonenumber-js (ISO2 code)
// Carrier: parsed.carrier (where available in libphonenumber-js metadata)
// isPremium: getNumberType() === 'PREMIUM_RATE'
```

Email classification:
```typescript
const PERSONAL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'icloud.com', 'live.com', 'aol.com', 'protonmail.com'
];
const GENERIC_PREFIXES = [
  'info', 'sales', 'contact', 'support', 'admin',
  'hello', 'team', 'office', 'enquiries', 'enquiry'
];

// Valid email format: simple regex /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// personal: valid format AND domain in PERSONAL_DOMAINS
// generic: valid format AND local part (before @) in GENERIC_PREFIXES
// business: valid format AND not personal AND not generic
// invalid: does not match email format regex
```

---

## sorter.ts — priority rank assignment

Region priority is read from `client_config.region_priority` (string
array, e.g. ['UAE', 'GCC', 'Western', 'SouthAsia', 'Other']).

Region-to-group mapping:
```typescript
const REGION_GROUPS: Record<string, string[]> = {
  UAE: ['AE'],
  GCC: ['SA', 'KW', 'QA', 'BH', 'OM'],
  Western: ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'NL', 'SE', 'NO', 'DK'],
  SouthAsia: ['PK', 'IN', 'BD', 'LK', 'NP'],
  Other: []   // everything else falls here
};

// Priority rank = index in client_config.region_priority array
// Lower index = higher priority = lower rank number = sent first
// Contacts in 'Other' get rank = region_priority.length (lowest priority)
// Within same region: mobile > landline (mobiles ranked before landlines)
// Exact duplicates and invalids get null rank (excluded from send)
```

---

## importer.ts — write to Supabase

```typescript
// For each batch of cleaned contacts, upsert into the contacts table.
// Use upsert on (client_id, phone_e164) unique constraint.
// On conflict: update status, invalid_reason, number_type, region,
//              priority_rank, email, email_type — but NOT lead_score,
//              human_controlled, opted_out (preserve existing CRM state).

// Also:
// - Insert a contact_imports row before processing starts (status = 'processing')
// - Update contact_imports row when done (status = 'completed', counts)
// - If any unhandled error: update status = 'failed', error_message

// Batch size: upsert 100 rows at a time to avoid Supabase payload limits
// Use Promise.all with batches — do not upsert row-by-row
```

---

## API route

```
POST /api/contacts/import
```

Request: `multipart/form-data` with:
- `file`: the uploaded Excel/CSV file
- `client_id`: UUID (from auth session, not user input)
- `default_country`: ISO2 code (optional, falls back to client_config
  region_priority[0] mapped to ISO2)

Response:
```json
{
  "import_id": "uuid",
  "counts": {
    "raw": 500,
    "clean": 412,
    "invalid": 43,
    "review": 18,
    "duplicate": 27
  }
}
```

The route is protected by Supabase Auth middleware. The client_id is
derived from the authenticated user's session — never taken from the
request body directly.

---

## Verification checklist

- [ ] Upload a file with all 9 edge cases from the original test data:
      +971501234567 (valid UAE), 0501234567 (local format),
      +971 50 123 4567 (spaces), +971-50-123-4567 (dashes),
      971501234567.0 (Excel float), empty row, duplicate, 123 (too short),
      +923001234567 (Pakistan)
- [ ] Verify all 9 produce the expected status/E.164 in contacts table
- [ ] Verify RLS: user from Client A cannot read Client B's contacts
- [ ] Verify contact_imports row created with correct counts
- [ ] Verify upsert does not overwrite lead_score or human_controlled
- [ ] Verify landlines are classified correctly (not mobile)
- [ ] Verify priority_rank reflects client_config.region_priority order
- [ ] Verify email classification for all four types
