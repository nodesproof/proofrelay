-- ProofRelay read model.
--
-- Nothing canonical lives here. Every row is derived from a chain event or from
-- an artifact in 0G Storage, and the whole schema can be truncated and rebuilt
-- from block PROOFRELAY_DEPLOY_BLOCK. That is why there are no ON DELETE
-- CASCADE subtleties to preserve and no sequence anyone depends on: when the
-- database disagrees with the chain, the chain wins and this gets replayed.

CREATE TABLE IF NOT EXISTS indexer_state (
  id                 SMALLINT PRIMARY KEY DEFAULT 1,
  chain_id           BIGINT      NOT NULL,
  contract           TEXT        NOT NULL,
  last_block         BIGINT      NOT NULL,
  last_error         TEXT,
  processed_events   BIGINT      NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT indexer_state_singleton CHECK (id = 1)
);

-- Raw decoded log stream. The idempotency key is (chain_id, tx_hash, log_index)
-- exactly as the architecture doc requires, so a replay is a no-op rather than
-- a double count.
CREATE TABLE IF NOT EXISTS chain_events (
  id             BIGSERIAL PRIMARY KEY,
  chain_id       BIGINT      NOT NULL,
  tx_hash        TEXT        NOT NULL,
  log_index      INT         NOT NULL,
  block_number   BIGINT      NOT NULL,
  block_time     TIMESTAMPTZ NOT NULL,
  event_name     TEXT        NOT NULL,
  task_id        TEXT,
  actor          TEXT,
  payload        JSONB       NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS chain_events_block_idx ON chain_events (block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS chain_events_task_idx  ON chain_events (task_id, block_number DESC);
CREATE INDEX IF NOT EXISTS chain_events_name_idx  ON chain_events (event_name, block_number DESC);

CREATE TABLE IF NOT EXISTS tasks (
  task_id            TEXT PRIMARY KEY,
  sequence           BIGINT      NOT NULL,
  creator            TEXT        NOT NULL,
  status             SMALLINT    NOT NULL,
  outcome            SMALLINT    NOT NULL DEFAULT 0,
  bounty             NUMERIC(78,0) NOT NULL,
  verifier_count     INT         NOT NULL,
  committed_count    INT         NOT NULL DEFAULT 0,
  revealed_count     INT         NOT NULL DEFAULT 0,
  reward_bps         INT         NOT NULL DEFAULT 0,
  manifest_hash      TEXT        NOT NULL,
  manifest_pointer   TEXT        NOT NULL,
  rule_id            TEXT        NOT NULL,
  result_hash        TEXT,
  commit_deadline    TIMESTAMPTZ,
  reveal_deadline    TIMESTAMPTZ,
  dispute_deadline   TIMESTAMPTZ,
  consensus_at       TIMESTAMPTZ,
  -- Denormalised from the manifest so the task list does not need a storage
  -- read per row. Null until the manifest has been fetched and hash-checked.
  title              TEXT,
  question           TEXT,
  claim_count        INT,
  source_count       INT,
  primary_source     TEXT,
  manifest_verified  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_block      BIGINT,
  tx_hash            TEXT,
  created_at         TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks (created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_status_idx  ON tasks (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS tasks_creator_idx ON tasks (lower(creator), created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_sequence_idx ON tasks (sequence);

CREATE TABLE IF NOT EXISTS reports (
  id                BIGSERIAL PRIMARY KEY,
  task_id           TEXT        NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  verifier          TEXT        NOT NULL,
  commitment        TEXT        NOT NULL,
  report_hash       TEXT,
  report_pointer    TEXT,
  status            TEXT        NOT NULL,
  model_id          TEXT,
  pipeline_version  TEXT,
  body              JSONB,
  supported         INT,
  contradicted      INT,
  insufficient      INT,
  mean_confidence   DOUBLE PRECISION,
  evidence_coverage DOUBLE PRECISION,
  compute_provider  TEXT,
  compute_latency_ms INT,
  compute_verified  BOOLEAN,
  body_verified     BOOLEAN     NOT NULL DEFAULT FALSE,
  commit_tx         TEXT,
  reveal_tx         TEXT,
  committed_at      TIMESTAMPTZ,
  revealed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, verifier)
);
CREATE INDEX IF NOT EXISTS reports_verifier_idx ON reports (lower(verifier), revealed_at DESC);

CREATE TABLE IF NOT EXISTS consensus_results (
  task_id            TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE CASCADE,
  outcome            TEXT        NOT NULL,
  agreement_bps      INT         NOT NULL,
  result_hash        TEXT        NOT NULL,
  result_pointer     TEXT,
  conflicts          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  rewarded_verifiers JSONB       NOT NULL DEFAULT '[]'::jsonb,
  claims             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  body               JSONB,
  evaluated_at       TIMESTAMPTZ NOT NULL,
  tx_hash            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS disputes (
  task_id              TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE CASCADE,
  challenger           TEXT        NOT NULL,
  bond                 NUMERIC(78,0) NOT NULL,
  evidence_hash        TEXT        NOT NULL,
  evidence_pointer     TEXT        NOT NULL,
  reason               TEXT,
  disputed_claims      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  resolved             BOOLEAN     NOT NULL DEFAULT FALSE,
  upheld               BOOLEAN     NOT NULL DEFAULT FALSE,
  decision             TEXT,
  adjudication_hash    TEXT,
  adjudication_pointer TEXT,
  opened_at            TIMESTAMPTZ,
  deadline             TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  open_tx              TEXT,
  resolve_tx           TEXT
);

CREATE TABLE IF NOT EXISTS allocations (
  task_id     TEXT          NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  beneficiary TEXT          NOT NULL,
  amount      NUMERIC(78,0) NOT NULL,
  tx_hash     TEXT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, beneficiary)
);

CREATE TABLE IF NOT EXISTS verifiers (
  address            TEXT PRIMARY KEY,
  registered         BOOLEAN     NOT NULL DEFAULT FALSE,
  approved           BOOLEAN     NOT NULL DEFAULT FALSE,
  active             BOOLEAN     NOT NULL DEFAULT TRUE,
  stake              NUMERIC(78,0) NOT NULL DEFAULT 0,
  metadata_hash      TEXT,
  metadata_pointer   TEXT,
  label              TEXT,
  role               TEXT,
  model_id           TEXT,
  pipeline_version   TEXT,
  registered_block   BIGINT,
  registered_at      TIMESTAMPTZ,
  last_seen_at       TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The artifact index. It exists so the Artifacts page can list objects without
-- walking 0G Storage, and so a hash can be resolved to a pointer after a
-- gateway outage. byte_length and kind come from the object itself.
CREATE TABLE IF NOT EXISTS artifacts (
  object_hash    TEXT PRIMARY KEY,
  kind           TEXT        NOT NULL,
  task_id        TEXT,
  pointer        TEXT        NOT NULL,
  root_hash      TEXT,
  byte_length    BIGINT      NOT NULL,
  producer       TEXT,
  driver         TEXT        NOT NULL,
  name           TEXT        NOT NULL,
  hash_verified  BOOLEAN     NOT NULL DEFAULT FALSE,
  -- The verified body, cached so /v1/reports/{hash} can answer while 0G Storage
  -- is unreachable. Only ever written after the hash checked out, which is what
  -- lets the response be marked "source":"cache" without weakening the claim.
  body           JSONB,
  upload_tx      TEXT,
  artifact_created_at TIMESTAMPTZ,
  first_seen_block    BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_task_idx    ON artifacts (task_id);
CREATE INDEX IF NOT EXISTS artifacts_kind_idx    ON artifacts (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS artifacts_created_idx ON artifacts (created_at DESC);

-- Manifests, denormalised. A task list of 50 rows must not mean 50 storage
-- reads, and the body here has already been hash-checked against the chain.
CREATE TABLE IF NOT EXISTS manifests (
  manifest_hash    TEXT PRIMARY KEY,
  manifest_pointer TEXT        NOT NULL,
  chain_id         BIGINT      NOT NULL,
  creator          TEXT        NOT NULL,
  rule_id          TEXT        NOT NULL,
  title            TEXT        NOT NULL,
  question         TEXT        NOT NULL,
  claim_count      INT         NOT NULL,
  source_count     INT         NOT NULL,
  body             JSONB       NOT NULL,
  verified         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id               BIGSERIAL PRIMARY KEY,
  idempotency_key  TEXT UNIQUE NOT NULL,
  task_id          TEXT,
  job_type         TEXT        NOT NULL,
  status           TEXT        NOT NULL,
  attempts         INT         NOT NULL DEFAULT 0,
  last_error_code  TEXT,
  last_error       TEXT,
  next_retry_at    TIMESTAMPTZ,
  payload          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_due_idx    ON jobs (status, next_retry_at);
CREATE INDEX IF NOT EXISTS jobs_task_idx   ON jobs (task_id, created_at DESC);

-- Single-use SIWE nonces. Consumed transactionally after signature
-- verification, so a valid signature for a spent nonce is still rejected.
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce       TEXT PRIMARY KEY,
  address     TEXT        NOT NULL,
  chain_id    BIGINT      NOT NULL,
  domain      TEXT        NOT NULL,
  statement   TEXT        NOT NULL,
  issued_at   TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_nonces_expiry_idx ON auth_nonces (expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  address     TEXT        NOT NULL,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- Replay protection for mutating endpoints. A repeated Idempotency-Key with the
-- same request body replays the stored response; with a different body it is a
-- 409, because silently serving the first answer to a second question is worse
-- than an error.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  route        TEXT        NOT NULL,
  request_hash TEXT        NOT NULL,
  status_code  INT,
  response     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idempotency_created_idx ON idempotency_keys (created_at);
