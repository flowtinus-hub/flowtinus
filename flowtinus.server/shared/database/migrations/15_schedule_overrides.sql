ALTER TABLE flow_schedules
  ADD COLUMN cron_override text,
  ADD COLUMN timezone_override text,
  ADD COLUMN input_override jsonb,
  ADD COLUMN parameter_overrides jsonb NOT NULL DEFAULT '{}';
