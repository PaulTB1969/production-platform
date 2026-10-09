-- Sending transfers and assemblies straight to Unleashed (instead of CSV).
--
-- send_started_at is written BEFORE calling Unleashed. If it's set but
-- unleashed_guid isn't, a send may have reached Unleashed without the reply
-- getting back here — the next attempt first looks for the record by the
-- [PH <id>] tag in its Comments, so a retry never creates a duplicate.
--
-- exported_at / transfer_number keep their meaning ("Unleashed has it" /
-- its number), whether it went by CSV or API.

ALTER TABLE requisitions
  ADD COLUMN unleashed_guid   text,
  ADD COLUMN send_started_at  timestamptz,
  ADD COLUMN send_error       text;

ALTER TABLE schedule_entries
  ADD COLUMN unleashed_guid    text,
  ADD COLUMN unleashed_number  text,
  ADD COLUMN send_started_at   timestamptz,
  ADD COLUMN send_error        text,
  -- The assembly exists but attaching component batch numbers failed.
  ADD COLUMN tracking_error    text;
