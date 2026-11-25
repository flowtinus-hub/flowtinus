ALTER TABLE promotions DROP CONSTRAINT promotions_state_check;
ALTER TABLE promotions ADD CONSTRAINT promotions_state_check CHECK (state IN ('open', 'broken', 'merged', 'closed'));
