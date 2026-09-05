-- Sponsored tasks: the free first one.
--
-- `createTask` has no privileged caller, so a sponsorship needs no contract
-- change — the sponsor's key simply signs the transaction and the contract
-- records `msg.sender` as the creator. That is also the fact this table exists
-- to keep straight: the *creator* onchain is the sponsor, and the wallet that
-- asked for the task is only recorded here and inside the manifest. Nobody can
-- read the beneficiary off the chain, so it has to be readable here.
--
-- A row is written BEFORE the broadcast, not after. The quota has to be
-- decided against something durable: counting only granted rows would let two
-- concurrent requests both see "0 used" and both spend.
CREATE TABLE IF NOT EXISTS sponsorships (
  id           BIGSERIAL PRIMARY KEY,
  -- The signed-in wallet the task is for. Lowercased on write, like every other
  -- address column since 003.
  beneficiary  TEXT        NOT NULL,
  -- The address that actually sent createTask, i.e. the onchain creator.
  sponsor      TEXT        NOT NULL,
  -- RESERVED — a slot is held and the broadcast has not resolved.
  -- GRANTED  — the task exists onchain and `task_id` names it.
  -- FAILED   — the attempt ended without a task; the slot is free again.
  status       TEXT        NOT NULL DEFAULT 'RESERVED',
  task_id      TEXT,
  bounty_wei   NUMERIC(78,0) NOT NULL,
  tx_hash      TEXT,
  -- Why a FAILED row failed, so an operator is not left guessing which of
  -- storage, compute or the chain refused.
  reason       TEXT,
  reserved_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at   TIMESTAMPTZ
);

-- The quota query: everything this address holds or has been granted.
CREATE INDEX IF NOT EXISTS sponsorships_beneficiary_idx
  ON sponsorships (lower(beneficiary), reserved_at DESC);

-- The global cap, and the reaper that ages out abandoned reservations.
CREATE INDEX IF NOT EXISTS sponsorships_status_idx
  ON sponsorships (status, reserved_at DESC);

-- One sponsorship per task. Two rows claiming the same task would double-count
-- the programme's spend, and a partial index is what lets the RESERVED rows —
-- which have no task yet — coexist.
CREATE UNIQUE INDEX IF NOT EXISTS sponsorships_task_idx
  ON sponsorships (task_id) WHERE task_id IS NOT NULL;
