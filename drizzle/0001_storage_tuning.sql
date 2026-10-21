-- Storage tuning for the tables that see repeated in-place updates.
--
-- A single find-leads run performs roughly eight phase heartbeats and six
-- partial-lead writes. Postgres never updates in place: every one of those
-- leaves a dead tuple behind.
--
-- fillfactor 70 leaves free space in each page so a heartbeat can be a HOT
-- (heap-only tuple) update, which avoids touching the table's four indexes.
--
-- find_leads_job_leads holds the partial_leads JSONB blob, which is rewritten
-- wholesale each time and can reach a few hundred KB. It gets a much more
-- aggressive autovacuum threshold so dead tuples are reclaimed promptly
-- rather than accumulating across a busy day of searches.

ALTER TABLE "find_leads_jobs" SET (fillfactor = 70);

ALTER TABLE "find_leads_job_leads" SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

-- Enrollments are updated on every cron tick that advances them.
ALTER TABLE "sequence_enrollments" SET (fillfactor = 85);
