/**
 * Task lifecycle vocabulary shared by the contract, the read model and the UI.
 *
 * The numeric values are the ones the deployed contract really uses — a task
 * that has been finalised reads back `status = 7`, an open one `status = 1`,
 * and a task settled on agreement reads `outcome = 1`. Renumbering these would
 * silently mis-render every historical task, so they are pinned here rather
 * than derived.
 */

/** PRD §9. `None` is the zero value a never-created task reads back as. */
export const TaskStatus = {
  None: 0,
  Open: 1,
  Committing: 2,
  Revealing: 3,
  Consensus: 4,
  Disputed: 5,
  Adjudication: 6,
  Finalized: 7,
  Expired: 8,
  Cancelled: 9,
} as const;
export type TaskStatusValue = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TASK_STATUS_NAMES = [
  "NONE",
  "OPEN",
  "COMMITTING",
  "REVEALING",
  "CONSENSUS",
  "DISPUTED",
  "ADJUDICATION",
  "FINALIZED",
  "EXPIRED",
  "CANCELLED",
] as const;
export type TaskStatusName = (typeof TASK_STATUS_NAMES)[number];

export function statusName(value: number): TaskStatusName {
  return TASK_STATUS_NAMES[value] ?? "NONE";
}

/** `outcome` on the task struct; 0 until the task settles. */
/**
 * Neither of the last two is a guess. Cancelling a live task on the deployed
 * contract stores 5 and emits `TaskFinalized(taskId, 0x0, 5)`; expiring a task
 * nobody revealed on stores 4. Both were read back off the chain.
 */
export const Outcome = { None: 0, Consensus: 1, Conflict: 2, NoQuorum: 3, Expired: 4, Cancelled: 5 } as const;
export const OUTCOME_NAMES = ["NONE", "CONSENSUS", "CONFLICT", "NO_QUORUM", "EXPIRED", "CANCELLED"] as const;
export type OutcomeName = (typeof OUTCOME_NAMES)[number];

export function outcomeName(value: number): OutcomeName {
  return OUTCOME_NAMES[value] ?? "NONE";
}

/**
 * The label the UI shows. Deliberately coarser than the contract status: the
 * Evidence Ledger design has three task tones (lime / sky / coral) and a task
 * is only "verified" once it settled on agreement.
 */
export type DisplayStatus = "VERIFIED" | "IN REVIEW" | "DISPUTED" | "EXPIRED" | "CANCELLED";
export type DisplayTone = "lime" | "sky" | "coral" | "ink";

export function displayStatus(status: number, outcome: number): DisplayStatus {
  if (status === TaskStatus.Cancelled) return "CANCELLED";
  if (status === TaskStatus.Expired) return "EXPIRED";
  if (status === TaskStatus.Disputed || status === TaskStatus.Adjudication) return "DISPUTED";
  if (status === TaskStatus.Finalized) {
    return outcome === Outcome.Consensus ? "VERIFIED" : "DISPUTED";
  }
  return "IN REVIEW";
}

export function displayTone(display: DisplayStatus): DisplayTone {
  switch (display) {
    case "VERIFIED":
      return "lime";
    case "DISPUTED":
      return "coral";
    case "EXPIRED":
    case "CANCELLED":
      return "ink";
    default:
      return "sky";
  }
}

/**
 * Consensus rule identity. A task records which rule evaluated it so a report
 * stays reproducible when the rule changes (architecture doc §8).
 */
export interface ConsensusRule {
  ruleId: `0x${string}`;
  name: string;
  requiredAgreement: number;
  minimumEvidenceCoverage: number;
  minimumConfidence: number;
  minimumEvidenceOverlap: number;
}

/** The rule the currently deployed contract's live tasks were created under. */
export const LEGACY_RULE_ID =
  "0x454d618f70c0d1847a2a451e6c25314ed6f3de0e0c91ec9888b70f8c797cf2c9" as const;

export const DEFAULT_RULE: ConsensusRule = {
  ruleId: LEGACY_RULE_ID,
  name: "majority-agreement-v1",
  requiredAgreement: 2,
  minimumEvidenceCoverage: 0.8,
  minimumConfidence: 0.55,
  minimumEvidenceOverlap: 0.5,
};

export const RULES: Record<string, ConsensusRule> = {
  [DEFAULT_RULE.ruleId.toLowerCase()]: DEFAULT_RULE,
};

export function resolveRule(ruleId: string | null | undefined): ConsensusRule {
  if (!ruleId) return DEFAULT_RULE;
  return RULES[ruleId.toLowerCase()] ?? { ...DEFAULT_RULE, ruleId: ruleId as `0x${string}` };
}

/** Orchestrator job types (architecture doc §9.2). */
export const JOB_TYPES = [
  "SOURCE_SNAPSHOT",
  "MANIFEST_UPLOAD",
  "VERIFIER_DISPATCH",
  "COMMIT_SUBMISSION",
  "REVEAL_SUBMISSION",
  "CONSENSUS_EVALUATION",
  "FINALIZATION",
  "NOTIFICATION",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
