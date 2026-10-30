import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

import { parseContactFile } from './loader';

function toArrayBuffer(data: unknown): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const buf = data as {
    buffer: ArrayBuffer;
    byteOffset: number;
    byteLength: number;
  };
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function buildFile(aoa: unknown[][], bookType: 'xlsx' | 'csv'): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return toArrayBuffer(XLSX.write(wb, { type: 'array', bookType }));
}

describe('parseContactFile', () => {
  it('detects phone/name/email columns and parses rows in order', () => {
    const buffer = buildFile(
      [
        ['Mobile Number', 'Full Name', 'Email Address'],
        [971501234567, 'John Doe', 'john@gmail.com'],
        ['0501234567', 'Jane', 'jane@acme.com'],
      ],
      'xlsx',
    );

    const parsed = parseContactFile(buffer, 'contacts.xlsx');
    expect(parsed.phoneIndex).toBe(0);
    expect(parsed.nameIndex).toBe(1);
    expect(parsed.emailIndex).toBe(2);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].rawPhone).toBe('971501234567');
    expect(parsed.rows[0].rawName).toBe('John Doe');
    expect(parsed.rows[0].rawEmail).toBe('john@gmail.com');
    expect(parsed.rows[1].raw['Mobile Number']).toBe('0501234567');
  });

  it('strips the Excel float suffix from both numeric and string cells', () => {
    const buffer = buildFile(
      [
        ['Phone', 'Name'],
        [971501234567, 'numeric'],
        ['971501234567.0', 'string'],
      ],
      'xlsx',
    );

    const parsed = parseContactFile(buffer, 'contacts.xlsx');
    expect(parsed.rows[0].rawPhone).toBe('971501234567');
    expect(parsed.rows[1].rawPhone).toBe('971501234567');
  });

  it('parses .csv content with identical float stripping', () => {
    const buffer = buildFile(
      [
        ['phone', 'name'],
        ['971501234567.0', 'A'],
        ['0501234567', 'B'],
      ],
      'csv',
    );

    const parsed = parseContactFile(buffer, 'contacts.csv');
    expect(parsed.phoneIndex).toBe(0);
    expect(parsed.rows[0].rawPhone).toBe('971501234567');
    expect(parsed.rows[1].rawPhone).toBe('0501234567');
  });

  it('picks the first phone-like column when several match', () => {
    const buffer = buildFile(
      [
        ['whatsapp', 'phone'],
        ['0501234567', '+971501234567'],
      ],
      'xlsx',
    );

    const parsed = parseContactFile(buffer, 'mixed.xlsx');
    expect(parsed.phoneIndex).toBe(0);
    expect(parsed.rows[0].rawPhone).toBe('0501234567');
  });

  it('matches headers case-insensitively after trimming', () => {
    const buffer = buildFile([['  PHONE  ', 'Name'], ['0501234567', 'A']], 'xlsx');

    const parsed = parseContactFile(buffer, 'messy.xlsx');
    expect(parsed.phoneIndex).toBe(0);
    expect(parsed.rows[0].rawPhone).toBe('0501234567');
  });

  it('throws listing detected columns when no phone column exists', () => {
    const buffer = buildFile([['Name', 'Email'], ['John', 'j@x.com']], 'xlsx');

    expect(() => parseContactFile(buffer, 'nophones.xlsx')).toThrow(
      /No phone column found/,
    );
    expect(() => parseContactFile(buffer, 'nophones.xlsx')).toThrow(/Name/);
    expect(() => parseContactFile(buffer, 'nophones.xlsx')).toThrow(/Email/);
  });

  it('keeps hinterior blank rows as empty-phone rows (→ invalid empty later)', () => {
    const buffer = buildFile(
      [
        ['Phone', 'Name'],
        ['0501234567', 'A'],
        [],
        ['0501234568', 'B'],
      ],
      'xlsx',
    );

    const parsed = parseContactFile(buffer, 'blanks.xlsx');
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[1].rawPhone).toBe('');
    expect(parsed.rows[1].rawName).toBeNull();
  });
});