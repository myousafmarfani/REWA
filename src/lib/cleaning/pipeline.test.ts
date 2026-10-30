import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

import { runCleanPipeline } from './index';

function toArrayBuffer(data: unknown): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const buf = data as {
    buffer: ArrayBuffer;
    byteOffset: number;
    byteLength: number;
  };
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function xlsxBuffer(rows: unknown[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return toArrayBuffer(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

const REGION_PRIORITY = ['UAE', 'GCC', 'Western', 'SouthAsia', 'Other'];

describe('runCleanPipeline — specimen 9-edge-case file', () => {
  it('partitions the verification rows correctly', async () => {
    const buffer = xlsxBuffer([
      ['Phone', 'Name', 'Email'],
      ['+971501234567', 'Alice', 'alice@gmail.com'],
      ['0501234567', 'Bob', 'bob@acme.com'],
      ['+971 50 123 4567', 'Carol', ''],
      ['+971-50-123-4567', '', ''],
      ['971501234567.0', '', ''],
      ['', '', ''],
      ['123', '', ''],
      ['+923001234567', 'Zara', 'zara@notgmail.com'],
    ]);

    const result = await runCleanPipeline({
      buffer,
      filename: 'specimen.xlsx',
      defaultCountry: 'AE',
      regionPriority: REGION_PRIORITY,
    });

    // Exact duplicate collapses via the unique E.164 key — 4 of the 8
    // data rows normalise to +971501234567 (already-E.164, local, spaces,
    // dashes, Excel float), so first is clean, rest are duplicates.
    expect(result.duplicate).toHaveLength(4);
    expect(result.invalid).toHaveLength(2); // empty row + too_short '123'
    expect(result.review).toHaveLength(0);

    const [alice, zara] = result.clean;
    expect(alice.phoneE164).toBe('+971501234567');
    expect(alice.status).toBe('clean');
    expect(alice.numberType).toBe('mobile');
    expect(alice.region).toBe('AE');
    expect(alice.emailType).toBe('personal');
    expect(alice.priorityRank).toBe(0);

    expect(zara.phoneE164).toBe('+923001234567');
    expect(zara.region).toBe('PK');
    expect(zara.emailType).toBe('business'); // notgmail.com is NOT personal
    expect(zara.priorityRank).toBe(3); // SouthAsia at index 3

    const empty = result.invalid.find((c) => c.invalidReason === 'empty')!;
    const tooShort = result.invalid.find((c) => c.invalidReason === 'too_short')!;
    expect(empty.phoneE164).toBe('EMPTY');
    expect(tooShort.phoneE164).toBe('123');

    // 8 data rows in, 8 contacts out across the four partitions.
    const raw =
      result.clean.length +
      result.invalid.length +
      result.review.length +
      result.duplicate.length;
    expect(raw).toBe(8);
  });

  it('derives priority ranks from the client config, not a hardcoded default', async () => {
    const buffer = xlsxBuffer([
      ['phone'],
      ['+971501234567'],
      ['+923001234567'],
      ['+905551234567'],
    ]);

    const result = await runCleanPipeline({
      buffer,
      filename: 'ranks.xlsx',
      defaultCountry: 'AE',
      regionPriority: ['SouthAsia', 'UAE'],
    });

    const uae = result.clean.find((c) => c.region === 'AE')!;
    const pk = result.clean.find((c) => c.region === 'PK')!;
    const tr = result.clean.find((c) => c.region === 'TR')!;
    expect(pk.priorityRank!).toBeLessThan(uae.priorityRank!);
    expect(tr.priorityRank).toBe(2); // catch-all → region_priority.length
  });
});