-- Run order of jobs within a production date: set from the order of rows in
-- the uploaded schedule file, changed by dragging on the Schedule screen.
-- Every job in a split family (same group_id) shares its family's run_order,
-- so batch 1, 2, 3… stay together; seq orders them within the family.
ALTER TABLE schedule_entries ADD COLUMN run_order double precision;

-- Existing jobs: the order they were added, family by family.
WITH fam AS (
  SELECT group_id, date, MIN(created_at) AS anchor
    FROM schedule_entries GROUP BY group_id, date
), ranked AS (
  SELECT group_id, date, ROW_NUMBER() OVER (PARTITION BY date ORDER BY anchor, group_id) AS rn
    FROM fam
)
UPDATE schedule_entries e SET run_order = r.rn
  FROM ranked r
 WHERE e.group_id = r.group_id AND e.date = r.date;
