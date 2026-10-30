import type { CleanedContact } from './types';

// Region → group taxonomy. Additive beyond the spec (MENA, CIS, EastAsia
// and IE under Western added per domain review) — nothing removed. 'Other'
// is the catch-all with an explicit empty list.
export const REGION_GROUPS: Record<string, string[]> = {
  UAE: ['AE'],
  GCC: ['SA', 'KW', 'QA', 'BH', 'OM'],
  Western: ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'NL', 'SE', 'NO', 'DK', 'IE'],
  MENA: ['EG', 'LB', 'JO', 'SY', 'IQ'],
  CIS: ['RU', 'UA', 'KZ'],
  EastAsia: ['CN', 'HK', 'SG', 'TW'],
  SouthAsia: ['PK', 'IN', 'BD', 'LK', 'NP'],
  Other: [],
};

// Representative ISO2 per group, used by the orchestrator to derive a
// default parsing country from client_config.region_priority[0].
const DEFAULT_COUNTRY_BY_GROUP: Record<string, string | null> = {
  UAE: 'AE',
  GCC: 'SA',
  Western: 'GB',
  MENA: 'EG',
  CIS: 'RU',
  EastAsia: 'CN',
  SouthAsia: 'PK',
  Other: null,
};

export function groupToDefaultCountry(group: string): string | null {
  return DEFAULT_COUNTRY_BY_GROUP[group] ?? null;
}

export function regionToGroup(region: string | null): string {
  for (const [group, codes] of Object.entries(REGION_GROUPS)) {
    if (region !== null && codes.includes(region)) return group;
  }
  return 'Other';
}

/**
 * Assign a numeric priority_rank per the client's region_priority config.
 * Lower rank = higher priority = sent first. 'Other' and any group absent
 * from the config get region_priority.length (lowest priority). Invalids
 * and exact duplicates get null (excluded from send).
 */
export function assignPriorityRanks(
  contacts: CleanedContact[],
  regionPriority: string[],
): CleanedContact[] {
  return contacts.map((contact) => {
    if (contact.status === 'invalid' || contact.status === 'duplicate') {
      return { ...contact, priorityRank: null };
    }
    const group = regionToGroup(contact.region);
    const rank =
      group === 'Other'
        ? regionPriority.length
        : regionPriority.indexOf(group);
    return {
      ...contact,
      priorityRank: rank === -1 ? regionPriority.length : rank,
    };
  });
}