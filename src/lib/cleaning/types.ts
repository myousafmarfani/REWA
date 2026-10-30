export type CleaningStatus = 'clean' | 'invalid' | 'review' | 'duplicate';
export type InvalidReason =
  | 'empty'
  | 'too_short'
  | 'parse_failed'
  | 'invalid_region';
export type NumberType = 'mobile' | 'landline' | 'voip' | 'unknown';
export type EmailType = 'personal' | 'business' | 'generic' | 'invalid';

export interface RawRow {
  raw: Record<string, unknown>; // original row from file
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
  review: CleanedContact[]; // near-duplicates
  duplicate: CleanedContact[]; // exact duplicates
  importId: string;
}

// Non-import partitions of a pipeline run.
export type CleaningPartitions = Omit<CleaningResult, 'importId'>;

export interface CleaningCounts {
  raw: number;
  clean: number;
  invalid: number;
  review: number;
  duplicate: number;
}

// A parsed row carrying its normalisation outcome — the unit the
// deduplicator and sorter operate on.
export interface NormalisedContact extends ParsedContact {
  e164: string | null;
  invalidReason: InvalidReason | null;
}