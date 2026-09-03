-- Job leases.
--
-- `SELECT ... FOR UPDATE SKIP LOCKED` only holds a job for as long as the
-- claiming transaction is open, and an orchestrator job is not done inside a
-- transaction — a CONSENSUS_EVALUATION spends its time in 0G Storage, not in
-- Postgres. So the claim is recorded on the row: who holds it and since when.
-- Without that, a worker killed mid-job leaves a RUNNING row nothing will ever
-- pick up again.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locked_by TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

-- The reaper's query: RUNNING rows whose lease has expired.
CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs (locked_at) WHERE status = 'RUNNING';
