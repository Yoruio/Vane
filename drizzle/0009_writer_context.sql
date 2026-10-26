-- Exactly what the writer was given, so an answer can be rewritten at a
-- different length without repeating the research.
--
-- Deliberately NOT folded into the 0003 baseline. Putting it in both meant a
-- fresh database ran 0003 (adding the column) and then 0009 (adding it again),
-- which fails with "duplicate column name". Existing databases never saw it
-- because they skip 0003, so the broken path was only the new-install one.
-- Keeping it here alone means both paths apply it exactly once.
ALTER TABLE messages ADD COLUMN writerContext TEXT;
