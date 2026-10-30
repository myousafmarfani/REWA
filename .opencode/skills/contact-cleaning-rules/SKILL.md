---
name: contact-cleaning-rules
description: Exact contact validation, deduplication, and priority-sorting rules carried over from the original dubai-re-outreach Python pipeline. Load before implementing or modifying any cleaning-spec logic — these edge cases were derived from real production data and must be preserved exactly, not reinvented.
---

# Contact Cleaning Rules

## Why this skill exists

The original Python pipeline (cleaner/) was built against real client
data from a Dubai property campaign. The edge cases below are not
hypothetical — they were found in actual Excel exports from CRM systems,
property portals, and event badge scanners. Every rule here exists
because a real row in a real file broke an earlier version.

Do not simplify, skip, or "modernise" these rules. Port them exactly.

## Phone normalisation — libphonenumber-js

Library: libphonenumber-js (TS). This is the direct equivalent of the
original Python google-libphonenumber. Use it the same way.

Default country: per-client config value (was hardcoded AE for the Dubai
client — this is now a per-client setting, not a global default).

### Input formats that must be handled correctly

| Raw input              | Expected E.164 output   | Reason                          |
|------------------------|-------------------------|---------------------------------|
| +971501234567          | +971501234567           | Already E.164 — pass through    |
| 0501234567             | +971501234567           | Local format, default country AE|
| +971 50 123 4567       | +971501234567           | Spaces between digits           |
| +971-50-123-4567       | +971501234567           | Dashes between digits           |
| 971501234567.0         | +971501234567           | Excel float — strip .0, add +   |
| (empty / null / NaN)   | → invalid, reason: empty| Do not attempt to parse         |
| 123                    | → invalid, reason: too_short | Below minimum digit count  |
| +923001234567          | +923001234567           | Non-UAE number — valid, keep    |

### Excel float handling — critical
Excel stores numeric-looking phone numbers as floats. A number like
971501234567 becomes 971501234567.0 in a pandas/openpyxl read. The TS
equivalent (reading via SheetJS or similar) produces the same artefact.
Before passing any value to libphonenumber-js, strip trailing .0 from
numeric strings and convert to string if the raw cell value is a number
type.

### Invalid number handling
Numbers that cannot be parsed must be flagged with a reason, not
silently dropped. Reasons: empty, too_short, parse_failed,
invalid_region. These go into the contacts table with
status = 'invalid' and the reason stored.

## Deduplication

### Exact duplicates
Detect on the normalised E.164 value. Keep the first occurrence (highest
row index = lowest priority). Mark subsequent occurrences as
status = 'duplicate'. Do not delete — mark.

### Near-duplicates
Flag contacts where the first 10 digits of the E.164 number match but
the full number differs (e.g. a trailing digit typo, or a country code
variation). These go into status = 'review'. Do not auto-merge and do
not auto-drop. A human must review near-dupes before they proceed.

## Number classification

After normalisation and deduplication, classify each valid number:

- number_type: mobile | landline | voip | unknown
  (libphonenumber-js getNumberType())
- region: derived from the country code of the E.164 number
- carrier: where available from libphonenumber-js metadata
- is_premium: flag numbers on known premium-rate ranges

### Landline handling
Landlines must NOT be included in WhatsApp send campaigns. Flag them as
valid contacts but exclude from the send-eligible set. The sending-spec
must check number_type = 'mobile' before queuing a send.

## Priority sorting

The sort order is a per-client configuration value stored in the client
config table in Supabase. It is NOT hardcoded. The original UAE → GCC →
Western → SouthAsia → Other order was specific to one client and must
not appear as a default in the codebase.

The sorting mechanism: assign a numeric priority rank to each contact
based on their number's region matched against the client's configured
region_priority array. Lower rank = higher priority = sent first.

## Email classification

When an email column is present in the import:

- personal: gmail.com, yahoo.com, hotmail.com, outlook.com, icloud.com
- business: any domain not in the personal list and not generic
- generic: info@, sales@, contact@, support@, admin@, hello@
- invalid: does not match basic email format regex

Classification is stored in the contacts table as email_type. This
affects which message variant and subject line logic applies downstream
(relevant when Email channel is added — store now, use later).

## Output categories — four logical partitions

The original pipeline produced four Excel output files. In rewa these
become status values on the contacts table, not files. The four
categories must be preserved:

| Old file                    | New status value(s)         |
|-----------------------------|-----------------------------|
| contacts_clean.xlsx         | status = 'clean'            |
| contacts_invalid.xlsx       | status = 'invalid'          |
| contacts_review.xlsx        | status = 'review'           |
| contacts_with_email.xlsx    | Not a separate status — all |
|                             | clean contacts with a valid |
|                             | email get has_email = true  |

Do not collapse these into fewer categories. The distinction between
invalid (unparseable) and review (near-dupe, needs human decision) is
meaningful and must be preserved in the UI.

## Column auto-detection

The original loader.py auto-detected which column contained phone
numbers by matching against a list of known aliases. Port this logic:

Recognised phone column aliases (case-insensitive):
phone, mobile, number, contact, whatsapp, tel, telephone, cell,
phone_number, mobile_number, contact_number, whatsapp_number

Recognised name column aliases:
name, full_name, fullname, contact_name, client_name, lead_name,
first_name, last_name

If no phone column is detected, the import must fail with a clear error
message listing the columns that were found, not a generic parse error.
