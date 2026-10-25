-- Folded into 0003 for fresh databases; this file carries it to databases that
-- already ran 0003 and so skip the combined baseline.
ALTER TABLE messages ADD COLUMN writerContext TEXT;
