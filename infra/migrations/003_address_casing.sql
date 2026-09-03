-- One canonical casing for every address column that participates in a key.
--
-- `projections.ts addr()` preserved viem's checksum casing while `task-service`
-- wrote lowercase, and both write the same key columns. Postgres compares TEXT
-- byte-for-byte, so `UNIQUE (task_id, verifier)` and `PRIMARY KEY (task_id,
-- beneficiary)` never saw the collision: the same verifier could hold two rows
-- for one task, and a reader taking "the" row got whichever the plan returned.
-- The `lower(...)` indexes made joins work, which is what hid it.
--
-- Idempotent: re-running normalises nothing and re-adds nothing.

-- 1. Collapse rows that differ only by casing, newest wins. `created_at` is the
--    block the row describes, so the newest is the one the chain last confirmed.
DELETE FROM reports r
 USING reports keep
 WHERE r.task_id = keep.task_id
   AND lower(r.verifier) = lower(keep.verifier)
   AND (r.created_at, r.ctid) < (keep.created_at, keep.ctid);

DELETE FROM allocations a
 USING allocations keep
 WHERE a.task_id = keep.task_id
   AND lower(a.beneficiary) = lower(keep.beneficiary)
   AND (a.created_at, a.ctid) < (keep.created_at, keep.ctid);

DELETE FROM verifiers v
 USING verifiers keep
 WHERE lower(v.address) = lower(keep.address)
   AND v.ctid < keep.ctid;

-- 2. Normalise what is left.
UPDATE reports     SET verifier    = lower(verifier)    WHERE verifier    <> lower(verifier);
UPDATE allocations SET beneficiary = lower(beneficiary) WHERE beneficiary <> lower(beneficiary);
UPDATE verifiers   SET address     = lower(address)     WHERE address     <> lower(address);
UPDATE tasks       SET creator     = lower(creator)     WHERE creator     <> lower(creator);

-- 3. Enforce it in the schema rather than by convention, so a future writer that
--    forgets cannot reintroduce the split.
ALTER TABLE reports     DROP CONSTRAINT IF EXISTS reports_verifier_lowercase;
ALTER TABLE reports     ADD  CONSTRAINT reports_verifier_lowercase CHECK (verifier = lower(verifier));
ALTER TABLE allocations DROP CONSTRAINT IF EXISTS allocations_beneficiary_lowercase;
ALTER TABLE allocations ADD  CONSTRAINT allocations_beneficiary_lowercase CHECK (beneficiary = lower(beneficiary));
ALTER TABLE verifiers   DROP CONSTRAINT IF EXISTS verifiers_address_lowercase;
ALTER TABLE verifiers   ADD  CONSTRAINT verifiers_address_lowercase CHECK (address = lower(address));
