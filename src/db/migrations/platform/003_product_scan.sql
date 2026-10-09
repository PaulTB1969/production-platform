-- Counting a site's products (for the tracking mode) takes a minute or two
-- in Unleashed, so it runs in the background after Test & import.
ALTER TABLE sites ADD COLUMN product_scan_started_at timestamptz;
ALTER TABLE sites ADD COLUMN product_scan_error text;
