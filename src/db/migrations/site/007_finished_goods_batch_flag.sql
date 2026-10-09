-- Whether each finished good is batch-tracked in Unleashed (the BOM's
-- product flag). 214 of 385 are not (mostly private label): Unleashed keeps
-- no batch numbers for them, so collections mustn't require one.
-- NULL until the next Unleashed sync fills it in (treated as batch-tracked).
ALTER TABLE recipes ADD COLUMN is_batch_tracked boolean;
