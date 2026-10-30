import { describe, expect, it } from 'vitest';

import {
  assignPriorityRanks,
  groupToDefaultCountry,
  REGION_GROUPS,
  regionToGroup,
} from './sorter';
import type { CleanedContact } from './types';

function contact(overrides: Partial<CleanedContact>): CleanedContact {
  return {
    phoneE164: '+971501234567',
    fullName: null,
    email: null,
    emailType: null,
    status: 'clean',
    invalidReason: null,
    numberType: 'mobile',
    region: 'AE',
    carrier: null,
    isPremium: false,
    priorityRank: null,
    rawImport: {},
    ...overrides,
  };
}

describe('assignPriorityRanks', () => {
  it('ranks regions per the client config order', () => {
    const priority = ['UAE', 'Western', 'SouthAsia', 'Other'];
    const [uae, western, southAsia, other, dup, invalid] = assignPriorityRanks(
      [
        contact({ region: 'AE' }),
        contact({ region: 'GB' }),
        contact({ region: 'PK' }),
        contact({ region: 'JP' }),
        contact({ status: 'duplicate', region: 'AE' }),
        contact({ status: 'invalid', region: 'AE' }),
      ],
      priority,
    );

    expect(uae.priorityRank).toBe(0);
    expect(western.priorityRank).toBe(1);
    expect(southAsia.priorityRank).toBe(2);
    // Catch-all gets the lowest rank (region_priority.length).
    expect(other.priorityRank).toBe(4);
    expect(dup.priorityRank).toBeNull();
    expect(invalid.priorityRank).toBeNull();
  });

  it('treats a group absent from the config like Other', () => {
    const [gcc] = assignPriorityRanks(
      [contact({ region: 'SA' })],
      ['UAE', 'Western'],
    );
    expect(gcc.priorityRank).toBe(2);
  });

  it('does not mutate the input contacts', () => {
    const input = [contact({ region: 'AE' })];
    assignPriorityRanks(input, ['UAE']);
    expect(input[0].priorityRank).toBeNull();
  });
});

describe('groupToDefaultCountry', () => {
  it('maps each group to its representative ISO2', () => {
    expect(groupToDefaultCountry('UAE')).toBe('AE');
    expect(groupToDefaultCountry('GCC')).toBe('SA');
    expect(groupToDefaultCountry('Western')).toBe('GB');
    expect(groupToDefaultCountry('MENA')).toBe('EG');
    expect(groupToDefaultCountry('CIS')).toBe('RU');
    expect(groupToDefaultCountry('EastAsia')).toBe('CN');
    expect(groupToDefaultCountry('SouthAsia')).toBe('PK');
    expect(groupToDefaultCountry('Other')).toBeNull();
    expect(groupToDefaultCountry('MadeUp')).toBeNull();
  });
});

describe('domain-review REGION_GROUPS taxonomy', () => {
  it('carries the additive groups from the resolved decisions', () => {
    expect(REGION_GROUPS.UAE).toEqual(['AE']);
    expect(REGION_GROUPS.GCC).toEqual(['SA', 'KW', 'QA', 'BH', 'OM']);
    expect(REGION_GROUPS.Western).toContain('IE');
    expect(REGION_GROUPS.MENA).toContain('EG');
    expect(REGION_GROUPS.CIS).toContain('KZ');
    expect(REGION_GROUPS.EastAsia).toContain('SG');
    expect(REGION_GROUPS.SouthAsia).toEqual(['PK', 'IN', 'BD', 'LK', 'NP']);
    expect(REGION_GROUPS.Other).toEqual([]);
  });

  it('maps regions to the right group', () => {
    expect(regionToGroup('AE')).toBe('UAE');
    expect(regionToGroup('QA')).toBe('GCC');
    expect(regionToGroup('IE')).toBe('Western');
    expect(regionToGroup('EG')).toBe('MENA');
    expect(regionToGroup('RU')).toBe('CIS');
    expect(regionToGroup('CN')).toBe('EastAsia');
    expect(regionToGroup('XX')).toBe('Other');
    expect(regionToGroup(null)).toBe('Other');
  });
});