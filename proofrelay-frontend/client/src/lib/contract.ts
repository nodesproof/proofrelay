/**
 * The ProofRelay deployment this UI talks to, and the ABI it talks with.
 *
 * The address comes from VITE_PROOFRELAY_ADDRESS; the fallback is the live
 * Galileo deployment documented in docs/research/FRONTEND_DATA_CONTRACT.md.
 * The ABI below is copied verbatim from packages/chain-client/src/abi.ts —
 * every entry there was verified against the deployed runtime bytecode, so it
 * must not be edited independently of that file.
 */
import type { Address } from "./types";
import { ACTIVE_CHAIN_ID } from "./wagmi";

/** The deployment under contract: ProofRelay on 0G Galileo, chainId 16602. */
export const PROOFRELAY_FALLBACK_ADDRESS = "0xc1E353cb44eA09729143f06Af97E51FB952b33D7" as const;

/** Chain the compiled-in fallback belongs to. It is meaningless on any other. */
const FALLBACK_CHAIN_ID = 16602;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * A contract address is per-deployment AND per-chain. The Galileo fallback used
 * to apply on every build, so a mainnet build that forgot VITE_PROOFRELAY_ADDRESS
 * would point every read and every signature at an address that holds no code on
 * that chain — reads return nothing, writes revert, and neither says why. Off
 * the fallback's own chain the address is left zero and reported as unset, which
 * the UI can say out loud.
 */
function readAddress(): Address {
  const configured = import.meta.env.VITE_PROOFRELAY_ADDRESS;
  if (typeof configured === "string" && /^0x[0-9a-fA-F]{40}$/.test(configured.trim())) return configured.trim() as Address;
  return ACTIVE_CHAIN_ID === FALLBACK_CHAIN_ID ? PROOFRELAY_FALLBACK_ADDRESS : ZERO_ADDRESS;
}

/** The contract every write and every onchain read in this app is addressed to. */
export const PROOFRELAY_ADDRESS: Address = readAddress();

/** True when the address in use is the compiled-in fallback rather than an explicit env value. */
export const PROOFRELAY_ADDRESS_IS_FALLBACK = PROOFRELAY_ADDRESS === PROOFRELAY_FALLBACK_ADDRESS;

/** True when this build has no address for its chain at all: nothing onchain will work. */
export const PROOFRELAY_ADDRESS_IS_UNSET = PROOFRELAY_ADDRESS === ZERO_ADDRESS;

/**
 * Role ids are NOT hardcoded here: the contract exposes KEEPER_ROLE(),
 * ADJUDICATOR_ROLE(), PAUSER_ROLE() and DEFAULT_ADMIN_ROLE() as view functions,
 * so anything role-gated reads them from the chain rather than from a constant
 * that could drift from the deployment.
 */
export const ROLE_GETTERS = ["DEFAULT_ADMIN_ROLE", "KEEPER_ROLE", "ADJUDICATOR_ROLE", "PAUSER_ROLE"] as const;
export type RoleName = (typeof ROLE_GETTERS)[number];

export const proofRelayAbi = [
  /* ── task lifecycle ───────────────────────────────────────────────────── */
  {
    type: "function",
    name: "createTask",
    stateMutability: "payable",
    inputs: [
      {
        name: "spec",
        type: "tuple",
        components: [
          { name: "verifierCount", type: "uint32" },
          { name: "commitWindowSec", type: "uint32" },
          { name: "revealWindowSec", type: "uint32" },
          { name: "disputeWindowSec", type: "uint32" },
          { name: "manifestHash", type: "bytes32" },
          { name: "manifestPointer", type: "string" },
          { name: "ruleId", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "taskId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "cancelTask",
    stateMutability: "nonpayable",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "commitReport",
    stateMutability: "nonpayable",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "commitment", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revealReport",
    stateMutability: "nonpayable",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "reportHash", type: "bytes32" },
      { name: "reportPointer", type: "string" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "openChallenge",
    stateMutability: "payable",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "evidenceHash", type: "bytes32" },
      { name: "evidencePointer", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalizeConsensus",
    stateMutability: "nonpayable",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "resultHash", type: "bytes32" },
      { name: "outcome", type: "uint8" },
      { name: "beneficiaries", type: "address[]" },
      { name: "rewardBps", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "resolveDispute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "upheld", type: "bool" },
      { name: "adjudicationHash", type: "bytes32" },
      { name: "adjudicationPointer", type: "string" },
      { name: "beneficiaries", type: "address[]" },
      { name: "reasonHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalizeTask",
    stateMutability: "nonpayable",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "expireTask",
    stateMutability: "nonpayable",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "expireDispute",
    stateMutability: "nonpayable",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimReward",
    stateMutability: "nonpayable",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "refundCreator",
    stateMutability: "nonpayable",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
  },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [], outputs: [] },

  /* ── verifier registry ────────────────────────────────────────────────── */
  {
    type: "function",
    name: "registerVerifier",
    stateMutability: "payable",
    inputs: [
      { name: "metadataHash", type: "bytes32" },
      { name: "metadataPointer", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setVerifierActive",
    stateMutability: "nonpayable",
    inputs: [{ name: "active", type: "bool" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setVerifierApproval",
    stateMutability: "nonpayable",
    inputs: [
      { name: "verifier", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawStake",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },

  /* ── admin ────────────────────────────────────────────────────────────── */
  { type: "function", name: "pause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "unpause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "grantRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [],
  },

  /* ── views ────────────────────────────────────────────────────────────── */
  {
    type: "function",
    name: "getTask",
    stateMutability: "view",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [
      {
        name: "task",
        type: "tuple",
        components: [
          { name: "creator", type: "address" },
          { name: "bounty", type: "uint96" },
          { name: "verifierCount", type: "uint32" },
          { name: "commitDeadline", type: "uint32" },
          { name: "revealDeadline", type: "uint32" },
          { name: "disputeWindow", type: "uint32" },
          { name: "consensusAt", type: "uint32" },
          { name: "committedCount", type: "uint32" },
          { name: "revealedCount", type: "uint32" },
          { name: "rewardBps", type: "uint16" },
          { name: "status", type: "uint8" },
          { name: "outcome", type: "uint8" },
          { name: "manifestHash", type: "bytes32" },
          { name: "ruleId", type: "bytes32" },
          { name: "resultHash", type: "bytes32" },
          { name: "manifestPointer", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getReport",
    stateMutability: "view",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "verifier", type: "address" },
    ],
    outputs: [
      {
        name: "report",
        type: "tuple",
        components: [
          { name: "verifier", type: "address" },
          { name: "commitment", type: "bytes32" },
          { name: "revealed", type: "bool" },
          { name: "reportHash", type: "bytes32" },
          { name: "reportPointer", type: "string" },
          { name: "committedAt", type: "uint32" },
          { name: "revealedAt", type: "uint32" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getVerifier",
    stateMutability: "view",
    inputs: [{ name: "verifier", type: "address" }],
    outputs: [
      {
        name: "record",
        type: "tuple",
        components: [
          { name: "registered", type: "bool" },
          { name: "approved", type: "bool" },
          { name: "active", type: "bool" },
          { name: "stake", type: "uint96" },
          { name: "slashed", type: "uint96" },
          { name: "metadataHash", type: "bytes32" },
          { name: "metadataPointer", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getDispute",
    stateMutability: "view",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [
      {
        name: "dispute",
        type: "tuple",
        components: [
          { name: "challenger", type: "address" },
          { name: "bond", type: "uint96" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "evidencePointer", type: "string" },
          { name: "resolved", type: "bool" },
          { name: "upheld", type: "bool" },
          { name: "outcome", type: "uint8" },
          { name: "openedAt", type: "uint32" },
          { name: "deadline", type: "uint32" },
          { name: "adjudicationHash", type: "bytes32" },
          { name: "adjudicationPointer", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getTaskVerifiers",
    stateMutability: "view",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [{ name: "verifiers", type: "address[]" }],
  },
  {
    type: "function",
    name: "allocationOf",
    stateMutability: "view",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "pendingWithdrawals",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "creatorNonce",
    stateMutability: "view",
    inputs: [{ name: "creator", type: "address" }],
    outputs: [{ name: "nonce", type: "uint256" }],
  },
  {
    type: "function",
    name: "computeCommitment",
    stateMutability: "pure",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "verifier", type: "address" },
      { name: "reportHash", type: "bytes32" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "commitment", type: "bytes32" }],
  },
  {
    type: "function",
    name: "params",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "conflictRateBps", type: "uint16" },
      { name: "challengeBondBps", type: "uint16" },
      { name: "challengerRewardBps", type: "uint16" },
      { name: "adjudicatorSplitBps", type: "uint16" },
      { name: "verifierSlashBps", type: "uint16" },
      { name: "minBounty", type: "uint96" },
      { name: "minVerifierStake", type: "uint96" },
      { name: "keeperGracePeriod", type: "uint32" },
      { name: "adjudicationWindow", type: "uint32" },
      { name: "claimGracePeriod", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "totalLiabilities",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "total", type: "uint256" }],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "ok", type: "bool" }],
  },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "KEEPER_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "ADJUDICATOR_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "PAUSER_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "DEFAULT_ADMIN_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "MIN_WINDOW", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "MAX_WINDOW", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "MIN_VERIFIERS", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "MAX_VERIFIERS", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "MAX_DISPUTE_WINDOW", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "BPS_DENOMINATOR", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "MAX_POINTER_BYTES", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },

  /* ── events ───────────────────────────────────────────────────────────── */
  {
    type: "event",
    name: "TaskCreated",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "bounty", type: "uint256", indexed: false },
      { name: "manifestHash", type: "bytes32", indexed: false },
      { name: "ruleId", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TaskManifest",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "manifestPointer", type: "string", indexed: false },
      { name: "verifierCount", type: "uint32", indexed: false },
      { name: "commitDeadline", type: "uint32", indexed: false },
      { name: "revealDeadline", type: "uint32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ReportCommitted",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "verifier", type: "address", indexed: true },
      { name: "commitment", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ReportRevealed",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "verifier", type: "address", indexed: true },
      { name: "reportHash", type: "bytes32", indexed: false },
      { name: "reportPointer", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ChallengeOpened",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "challenger", type: "address", indexed: true },
      { name: "evidenceHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ConsensusReached",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "resultHash", type: "bytes32", indexed: false },
      { name: "outcome", type: "uint8", indexed: false },
      { name: "rewardBps", type: "uint16", indexed: false },
      { name: "disputeDeadline", type: "uint32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TaskFinalized",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "resultHash", type: "bytes32", indexed: false },
      { name: "outcome", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RewardAllocated",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "beneficiary", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DisputeResolved",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "upheld", type: "bool", indexed: false },
      { name: "adjudicationHash", type: "bytes32", indexed: false },
      { name: "adjudicationPointer", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VerifierRegistered",
    inputs: [
      { name: "verifier", type: "address", indexed: true },
      { name: "metadataHash", type: "bytes32", indexed: false },
      { name: "metadataPointer", type: "string", indexed: false },
      { name: "stake", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VerifierApprovalSet",
    inputs: [
      { name: "verifier", type: "address", indexed: true },
      { name: "approved", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RoleGranted",
    inputs: [
      { name: "role", type: "bytes32", indexed: true },
      { name: "account", type: "address", indexed: true },
    ],
  },

  /* ── custom errors ────────────────────────────────────────────────────── */
  { type: "error", name: "TaskNotFound", inputs: [] },
  { type: "error", name: "InvalidWindow", inputs: [] },
  { type: "error", name: "InvalidBounty", inputs: [] },
  { type: "error", name: "InvalidVerifierCount", inputs: [] },
  { type: "error", name: "InvalidOutcome", inputs: [] },
  { type: "error", name: "CommitmentMismatch", inputs: [] },
  { type: "error", name: "AlreadyRevealed", inputs: [] },
  { type: "error", name: "NotRevealer", inputs: [] },
  { type: "error", name: "VerifierNotActive", inputs: [] },
  { type: "error", name: "InsufficientBond", inputs: [] },
  { type: "error", name: "DisputeAlreadyResolved", inputs: [] },
  { type: "error", name: "ContractPaused", inputs: [] },
] as const;

/** Topic0 of every event the indexer subscribes to, verified against real logs. */
export const EVENT_TOPICS = {
  TaskCreated: "0x3d9dbf9a1c6dd67f61b2bb954c133f7843d7a0df07c70968f00f62d8c8dc7cf7",
  TaskManifest: "0xcfb9696d6c34a6684c9f40721b14d5c752d9a2107592b61902284a7cad395672",
  ReportCommitted: "0x001799dbc109c7b177e8d0c3775a742373439fc91b2f4fb4df89f51d57059337",
  ReportRevealed: "0x8c19f55e25ad65b87a37c54d6a8635cd9d67d740272127a08dffcdecb36c9887",
  ChallengeOpened: "0xbd355960608a5f337de898c1ba75454f7f391a6b6e3de397d43450936460ef48",
  ConsensusReached: "0x8dea753e21e06bbdafa37ed712d1e83d1e4facf321208902f6c204457ddcd474",
  TaskFinalized: "0xfe0cd2ac09173dac3e118cb5a2fed1db6691a9da253259a037f0b7a527ad45c0",
  RewardAllocated: "0x41d878d42b6c7f467ba0a796457613590b83f37914e120c6d52ba7bebe92ba7e",
  DisputeResolved: "0xa95e3f6386fad58561d8c6557f4a60092e03d3181d1bff8c5f2ca36ed6265200",
  VerifierRegistered: "0x802d068f16d044834528d1de8e2a67cb5686910010f3a965fa01ce615552e0a6",
  VerifierApprovalSet: "0x339a4be7fa0829dd458d677c617e1f32e96ee2a3fcb3bf9666e49af33ce846fe",
  RoleGranted: "0x2ae6a113c0ed5b78a53413ffbb7679881f11145ccfba4fb92e863dfcd5a1d2f3",
} as const;

export type ProofRelayEventName = keyof typeof EVENT_TOPICS;

export const INDEXED_EVENT_NAMES = Object.keys(EVENT_TOPICS) as ProofRelayEventName[];
