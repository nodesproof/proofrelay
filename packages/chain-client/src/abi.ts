/**
 * The ProofRelay contract ABI.
 *
 * Every entry here is verified against the contract deployed at
 * 0xc1E353cb44eA09729143f06Af97E51FB952b33D7 on 0G Galileo: the function
 * selectors were extracted from its runtime bytecode and matched against real
 * calldata, and the struct layouts were read back with eth_call. See
 * docs/recon/RECOVERED_ABI.md for the derivation.
 *
 * contracts/src/ProofRelay.sol compiles to this same ABI, so a fresh deployment
 * and the existing one are interchangeable.
 */
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
    // Emitted by `cancelTask`, alongside `TaskFinalized(taskId, 0x0, 5)`. It is
    // absent from every recon artifact because no cancellation had ever been
    // executed against the deployment until one was, deliberately, to find out.
    type: "event",
    name: "TaskCancelled",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "bounty", type: "uint256", indexed: false },
    ],
  },
  {
    // Emitted by `refundCreator`, which pays the creator's whole pending
    // balance rather than this task's share of it — the taskId names the call,
    // not the amount.
    type: "event",
    name: "RefundClaimed",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "creator", type: "address", indexed: true },
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
  {
    type: "event",
    name: "RewardReclaimed",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "beneficiary", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VerifierActiveSet",
    inputs: [
      { name: "verifier", type: "address", indexed: true },
      { name: "active", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "StakeWithdrawn",
    inputs: [
      { name: "verifier", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "remaining", type: "uint256", indexed: false },
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
  { type: "error", name: "NothingToWithdraw", inputs: [] },
  { type: "error", name: "DeadlineNotPassed", inputs: [] },
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
  TaskCancelled: "0x9954d6823ea6810a4780ffb920d7c2a569d41b2d0c99ea5d9314f8ba805de4bc",
  RefundClaimed: "0xe950d47bcc1a745a8ef1d8b86486b400a99681910425d126eb1a006d61f341b2",
  DisputeResolved: "0xa95e3f6386fad58561d8c6557f4a60092e03d3181d1bff8c5f2ca36ed6265200",
  VerifierRegistered: "0x802d068f16d044834528d1de8e2a67cb5686910010f3a965fa01ce615552e0a6",
  VerifierApprovalSet: "0x339a4be7fa0829dd458d677c617e1f32e96ee2a3fcb3bf9666e49af33ce846fe",
  RoleGranted: "0x2ae6a113c0ed5b78a53413ffbb7679881f11145ccfba4fb92e863dfcd5a1d2f3",
  // Added by this source, so absent from the 2024 deployment's logs. The check in
  // scripts/verify-abi.mjs recomputes each topic from the ABI entry rather than
  // looking for it on chain, so these are verified the same way as the rest.
  RewardReclaimed: "0x6fca17a5233ebb6e7e16a17f3606254de70dfad945287353ecdf2bbf7efd1557",
  VerifierActiveSet: "0xa08a2d3a5fa99bb69cd443487cbb3ef5376078aafc727c2f947c9d0922dbc875",
  StakeWithdrawn: "0x933735aa8de6d7547d0126171b2f31b9c34dd00f3ecd4be85a0ba047db4fafef",
} as const;

export type ProofRelayEventName = keyof typeof EVENT_TOPICS;

export const INDEXED_EVENT_NAMES = Object.keys(EVENT_TOPICS) as ProofRelayEventName[];
