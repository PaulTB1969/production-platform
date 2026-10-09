-- More than one requisition per line per date: the generated one is seq 1;
-- ones created by hand (e.g. a top-up later in the day) are 2, 3, …
ALTER TABLE requisitions DROP CONSTRAINT requisitions_date_line_key;
ALTER TABLE requisitions ADD COLUMN seq int NOT NULL DEFAULT 1;
ALTER TABLE requisitions ADD CONSTRAINT requisitions_date_line_seq_key UNIQUE (date, line, seq);
