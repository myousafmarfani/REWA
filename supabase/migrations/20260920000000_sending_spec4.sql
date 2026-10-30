-- ============================================================
-- Spec 4: WhatsApp Sending Pipeline — additive schema support
--
-- 1. campaigns.paused_reason
--    Distinguishes a quality-monitor pause from a manual dashboard
--    pause so the quality monitor only ever resumes campaigns IT
--    paused (spec 4: "resume paused campaigns if they were paused
--    due to quality (not due to manual pause)").
--
-- 2. contacts.opted_out_source CHECK extended with 'blocked'
--    A recipient who blocks the business number (or explicitly
--    opts out via Meta's opt-out tools) is detected at send time
--    from Meta error codes. That is consent evidence with
--    provenance (spec 1 A7), so the row must carry a source value
--    — never a NULL. Undeliverable / invalid numbers are NOT
--    recorded here; those map to contacts.status='invalid' instead.
-- ============================================================

alter table campaigns
  add column paused_reason text
  check (paused_reason is null or paused_reason in ('manual', 'quality'));

alter table contacts
  drop constraint contacts_opted_out_source_check;

alter table contacts
  add constraint contacts_opted_out_source_check
  check (opted_out_source in ('contact_reply', 'manual', 'import', 'blocked'));