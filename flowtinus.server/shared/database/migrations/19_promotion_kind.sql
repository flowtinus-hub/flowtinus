ALTER TABLE promotions ADD COLUMN kind text NOT NULL DEFAULT 'promotion' CHECK (kind IN ('promotion', 'backport'));
