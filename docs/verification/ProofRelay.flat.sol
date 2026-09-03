// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title ProofRelay
 * @notice An onchain evidence market for AI claims: a creator escrows a bounty,
 *         registered verifiers run a commit/reveal round, a keeper classifies
 *         the outcome, and every payout is derived from that classification
 *         rather than named by the caller.
 *
 * The external surface is not free to change. A deployment already exists at
 * 0xc1E353cb44eA09729143f06Af97E51FB952b33D7 on 0G Galileo (chainId 16602) and
 * the clients in packages/chain-client are pinned to it, so function names,
 * argument order, struct field order, event signatures, the enum values and the
 * two hash encodings below are all reproduced exactly from
 * docs/recon/RECOVERED_ABI.md. Renumbering TaskStatus would silently mis-render
 * every historical task; changing the commitment encoding would make a verifier
 * that already uploaded its report unable to reveal it.
 *
 * Access control, pausing and the reentrancy lock are inline rather than
 * inherited: this repo builds with zero Solidity libraries installed.
 */
contract ProofRelay {
    /* ── roles ────────────────────────────────────────────────────────────── */

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 public constant KEEPER_ROLE = keccak256("PROOFRELAY_KEEPER");
    bytes32 public constant ADJUDICATOR_ROLE = keccak256("PROOFRELAY_ADJUDICATOR");
    bytes32 public constant PAUSER_ROLE = keccak256("PROOFRELAY_PAUSER");

    /* ── bounds ───────────────────────────────────────────────────────────── */

    uint32 public constant MIN_WINDOW = 30;
    uint32 public constant MAX_WINDOW = 2_592_000;
    uint32 public constant MIN_VERIFIERS = 2;
    uint32 public constant MAX_VERIFIERS = 16;
    uint32 public constant MAX_DISPUTE_WINDOW = 2_592_000;
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_POINTER_BYTES = 256;

    /* ── types ────────────────────────────────────────────────────────────── */

    /// Pinned by live reads; the read model and the UI decode these numbers.
    enum TaskStatus {
        None,
        Open,
        Committing,
        Revealing,
        Consensus,
        Disputed,
        Adjudication,
        Finalized,
        Expired,
        Cancelled
    }

    /**
     * Both of the last two were read off the deployment rather than guessed:
     * cancelling stores 5, and expiring a task nobody revealed on stores 4.
     */
    enum Outcome {
        None,
        Consensus,
        Conflict,
        NoQuorum,
        Expired,
        Cancelled
    }

    /// Stored in `Dispute.outcome`, which the ABI exposes as a plain uint8.
    enum DisputeOutcome {
        None,
        Upheld,
        Rejected,
        Expired
    }

    struct TaskSpec {
        uint32 verifierCount;
        uint32 commitWindowSec;
        uint32 revealWindowSec;
        uint32 disputeWindowSec;
        bytes32 manifestHash;
        string manifestPointer;
        bytes32 ruleId;
    }

    struct Task {
        address creator;
        uint96 bounty;
        uint32 verifierCount;
        uint32 commitDeadline;
        uint32 revealDeadline;
        /// A duration, not a timestamp: the dispute deadline is consensusAt + this.
        uint32 disputeWindow;
        uint32 consensusAt;
        uint32 committedCount;
        uint32 revealedCount;
        uint16 rewardBps;
        TaskStatus status;
        Outcome outcome;
        bytes32 manifestHash;
        bytes32 ruleId;
        bytes32 resultHash;
        string manifestPointer;
    }

    struct Report {
        address verifier;
        bytes32 commitment;
        bool revealed;
        bytes32 reportHash;
        string reportPointer;
        uint32 committedAt;
        uint32 revealedAt;
    }

    struct VerifierRecord {
        bool registered;
        bool approved;
        bool active;
        uint96 stake;
        uint96 slashed;
        bytes32 metadataHash;
        string metadataPointer;
    }

    struct Dispute {
        address challenger;
        uint96 bond;
        bytes32 evidenceHash;
        string evidencePointer;
        bool resolved;
        bool upheld;
        DisputeOutcome outcome;
        uint32 openedAt;
        uint32 deadline;
        bytes32 adjudicationHash;
        string adjudicationPointer;
    }

    struct Params {
        /// Share of the bounty paid out when verifiers disagree.
        uint16 conflictRateBps;
        /// Challenge bond, as a share of the bounty. Exact msg.value is required.
        uint16 challengeBondBps;
        /// Paid to a challenger whose challenge is upheld, on top of the bond.
        uint16 challengerRewardBps;
        /// Share of a rejected challenger's forfeited bond that goes to the
        /// verifiers the adjudication defended; the rest returns to the creator.
        /// The adjudicator itself is never a beneficiary.
        uint16 adjudicatorSplitBps;
        /// Reserved. Slashing is implemented as a parameter only for the MVP and
        /// the live deployment runs it at zero.
        uint16 verifierSlashBps;
        uint96 minBounty;
        /// Reserved alongside verifierSlashBps; zero on the live deployment.
        uint96 minVerifierStake;
        /// After revealDeadline + this, expireTask is open to anyone.
        uint32 keeperGracePeriod;
        /// How long an adjudicator has before expireDispute is open to anyone.
        uint32 adjudicationWindow;
        /// Reserved. Pinned to the live value; no path gates on it today.
        uint32 claimGracePeriod;
    }

    /* ── events ───────────────────────────────────────────────────────────── */

    event TaskCreated(
        bytes32 indexed taskId, address indexed creator, uint256 bounty, bytes32 manifestHash, bytes32 ruleId
    );
    event TaskManifest(
        bytes32 indexed taskId,
        string manifestPointer,
        uint32 verifierCount,
        uint32 commitDeadline,
        uint32 revealDeadline
    );
    event ReportCommitted(bytes32 indexed taskId, address indexed verifier, bytes32 commitment);
    event ReportRevealed(bytes32 indexed taskId, address indexed verifier, bytes32 reportHash, string reportPointer);
    event ChallengeOpened(bytes32 indexed taskId, address indexed challenger, bytes32 evidenceHash);
    event ConsensusReached(
        bytes32 indexed taskId, bytes32 resultHash, uint8 outcome, uint16 rewardBps, uint32 disputeDeadline
    );
    event TaskFinalized(bytes32 indexed taskId, bytes32 resultHash, uint8 outcome);
    event RewardAllocated(bytes32 indexed taskId, address indexed beneficiary, uint256 amount);
    event TaskCancelled(bytes32 indexed taskId, address indexed creator, uint256 bounty);
    /// The amount is the creator's whole pending balance, not this task's share.
    event RefundClaimed(bytes32 indexed taskId, address indexed creator, uint256 amount);
    event DisputeResolved(bytes32 indexed taskId, bool upheld, bytes32 adjudicationHash, string adjudicationPointer);
    event VerifierRegistered(address indexed verifier, bytes32 metadataHash, string metadataPointer, uint256 stake);
    event VerifierApprovalSet(address indexed verifier, bool approved);
    event RoleGranted(bytes32 indexed role, address indexed account);
    /// The inverse of RewardAllocated. Without it an allocation the adjudicator
    /// unwound stays in the read model forever, because nothing observable says
    /// it went away — the threat model's claim that Postgres is "rebuildable from
    /// chain events" is only true if every mutation emits one.
    event RewardReclaimed(bytes32 indexed taskId, address indexed beneficiary, uint256 amount);
    /// Verifier liveness and stake mutate through two functions that were silent,
    /// so neither field could be rebuilt from logs.
    event VerifierActiveSet(address indexed verifier, bool active);
    event StakeWithdrawn(address indexed verifier, uint256 amount, uint256 remaining);
    /**
     * Emitted once, at deployment. The live contract emits an equivalent
     * deploy-time event with these ten fields, but its name could not be
     * recovered from the bytecode (docs/recon/RECOVERED_ABI.md), so the topic
     * here differs from the one on chain. Nothing indexes it: it is a record of
     * the economics the deployment was configured with, and the ABI the clients
     * are pinned to does not carry it.
     */
    event ParamsUpdated(
        uint16 conflictRateBps,
        uint16 challengeBondBps,
        uint16 challengerRewardBps,
        uint16 adjudicatorSplitBps,
        uint16 verifierSlashBps,
        uint96 minBounty,
        uint96 minVerifierStake,
        uint32 keeperGracePeriod,
        uint32 adjudicationWindow,
        uint32 claimGracePeriod
    );

    /* ── errors ───────────────────────────────────────────────────────────── */

    error TaskNotFound();
    error InvalidWindow();
    error InvalidBounty();
    error InvalidVerifierCount();
    error InvalidOutcome();
    error CommitmentMismatch();
    error AlreadyRevealed();
    error NotRevealer();
    error VerifierNotActive();
    error InsufficientBond();
    error DisputeAlreadyResolved();
    error ContractPaused();

    error TaskExists();
    error InvalidStatus();
    error NotAuthorized();
    error PointerTooLong();
    error AlreadyCommitted();
    error CommitClosed();
    error RevealNotOpen();
    error RevealNotClosed();
    error DeadlinePassed();
    error WindowNotElapsed();
    /// The deployment's own gate on `expireTask`: selector 0x2eb35430.
    error DeadlineNotPassed();
    error TooManyCommitments();
    error InvalidRewardBps();
    error InvalidBeneficiary();
    error DuplicateBeneficiary();
    error NothingToClaim();
    error NothingToWithdraw();
    error TransferFailed();
    error ReentrantCall();
    error DisputeExists();
    error DisputeNotFound();
    error NotRegistered();
    error InsufficientStake();
    /// A reveal or a challenge that names no content at all.
    error EmptyArtifact();

    /* ── state ────────────────────────────────────────────────────────────── */

    Params public params;
    bool public paused;

    mapping(address => uint256) public creatorNonce;
    mapping(address => uint256) public pendingWithdrawals;

    mapping(bytes32 => Task) private _tasks;
    mapping(bytes32 => mapping(address => Report)) private _reports;
    mapping(bytes32 => address[]) private _taskVerifiers;
    mapping(bytes32 => Dispute) private _disputes;
    mapping(address => VerifierRecord) private _verifiers;
    mapping(bytes32 => mapping(address => uint256)) private _allocations;
    mapping(bytes32 => mapping(address => bool)) private _roles;

    /**
     * Liabilities are tracked in four disjoint buckets so `totalLiabilities`
     * costs one read per bucket instead of a scan, and so the solvency
     * invariant is checkable at any point in a transaction sequence:
     * escrow held against live tasks, allocations awaiting a claim, balances
     * awaiting a withdrawal, and verifier stake.
     */
    uint256 private _escrowed;
    uint256 private _allocated;
    uint256 private _pending;
    uint256 private _staked;

    uint256 private _lock = 1;

    /* ── modifiers ────────────────────────────────────────────────────────── */

    modifier onlyRole(bytes32 role) {
        if (!_roles[role][msg.sender]) revert NotAuthorized();
        _;
    }

    /**
     * Pause covers only the paths that take new escrow or new evidence:
     * create, commit, reveal, challenge and registration. Finalization, expiry,
     * claims and withdrawals stay open on purpose — an admin must never be able
     * to trap escrow (architecture doc §15, threat model "trapping escrow").
     */
    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert ReentrantCall();
        _lock = 2;
        _;
        _lock = 1;
    }

    /* ── construction ─────────────────────────────────────────────────────── */

    constructor(address admin, address keeper, address adjudicator) {
        if (admin == address(0)) revert NotAuthorized();

        _grant(DEFAULT_ADMIN_ROLE, admin);
        _grant(PAUSER_ROLE, admin);
        if (keeper != address(0)) _grant(KEEPER_ROLE, keeper);
        if (adjudicator != address(0)) _grant(ADJUDICATOR_ROLE, adjudicator);

        params = Params({
            conflictRateBps: 5_000,
            challengeBondBps: 1_000,
            challengerRewardBps: 1_000,
            adjudicatorSplitBps: 5_000,
            verifierSlashBps: 0,
            minBounty: 1e14,
            minVerifierStake: 0,
            keeperGracePeriod: 3 days,
            adjudicationWindow: 7 days,
            claimGracePeriod: 7 days
        });

        emit ParamsUpdated(
            params.conflictRateBps,
            params.challengeBondBps,
            params.challengerRewardBps,
            params.adjudicatorSplitBps,
            params.verifierSlashBps,
            params.minBounty,
            params.minVerifierStake,
            params.keeperGracePeriod,
            params.adjudicationWindow,
            params.claimGracePeriod
        );
    }

    /* ── task lifecycle ───────────────────────────────────────────────────── */

    /**
     * @notice Escrow a bounty and open a task for verification.
     * @dev The id is derived rather than sequential so a client can predict it
     *      before the transaction lands: keccak256(chainId, contract, creator,
     *      nonce). Including the chain id and this address keeps ids from
     *      colliding across a testnet and a mainnet deployment.
     */
    function createTask(TaskSpec calldata spec) external payable whenNotPaused returns (bytes32 taskId) {
        if (spec.verifierCount < MIN_VERIFIERS || spec.verifierCount > MAX_VERIFIERS) revert InvalidVerifierCount();
        if (spec.commitWindowSec < MIN_WINDOW || spec.commitWindowSec > MAX_WINDOW) revert InvalidWindow();
        if (spec.revealWindowSec < MIN_WINDOW || spec.revealWindowSec > MAX_WINDOW) revert InvalidWindow();
        if (spec.disputeWindowSec < MIN_WINDOW || spec.disputeWindowSec > MAX_DISPUTE_WINDOW) revert InvalidWindow();
        if (msg.value < params.minBounty || msg.value > type(uint96).max) revert InvalidBounty();
        if (bytes(spec.manifestPointer).length > MAX_POINTER_BYTES) revert PointerTooLong();

        uint256 nonce = creatorNonce[msg.sender];
        creatorNonce[msg.sender] = nonce + 1;
        taskId = keccak256(abi.encode(block.chainid, address(this), msg.sender, nonce));

        Task storage t = _tasks[taskId];
        if (t.status != TaskStatus.None) revert TaskExists();

        uint256 commitDeadline = block.timestamp + spec.commitWindowSec;
        uint256 revealDeadline = commitDeadline + spec.revealWindowSec;
        if (revealDeadline > type(uint32).max) revert InvalidWindow();

        t.creator = msg.sender;
        t.bounty = uint96(msg.value);
        t.verifierCount = spec.verifierCount;
        t.commitDeadline = uint32(commitDeadline);
        t.revealDeadline = uint32(revealDeadline);
        t.disputeWindow = spec.disputeWindowSec;
        t.status = TaskStatus.Open;
        t.manifestHash = spec.manifestHash;
        t.ruleId = spec.ruleId;
        t.manifestPointer = spec.manifestPointer;

        _escrowed += msg.value;

        emit TaskCreated(taskId, msg.sender, msg.value, spec.manifestHash, spec.ruleId);
        emit TaskManifest(
            taskId, spec.manifestPointer, spec.verifierCount, t.commitDeadline, t.revealDeadline
        );
    }

    /// @notice Withdraw a task that no verifier has committed to yet.
    function cancelTask(bytes32 taskId) external {
        Task storage t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound();
        if (msg.sender != t.creator) revert NotAuthorized();
        // Any approved verifier may commit to any open task, so gating on
        // `committedCount == 0` let one garbage commitment nobody can ever reveal
        // brick cancellation and hold the creator's escrow for the whole window.
        // What must be protected is revealed work, not a hash.
        if (t.status != TaskStatus.Open && t.status != TaskStatus.Committing) revert InvalidStatus();
        if (t.revealedCount != 0 || block.timestamp > t.commitDeadline) revert InvalidStatus();

        uint256 bounty = t.bounty;
        t.status = TaskStatus.Cancelled;
        t.outcome = Outcome.Cancelled;

        // The refund skips `_allocations` and lands straight in the creator's
        // withdrawable balance, so `allocationOf` reads zero for a cancelled
        // task for the whole of its life. That is the deployed behaviour, and
        // the read model depends on `TaskCancelled` to see the credit at all.
        _escrowed -= bounty;
        _pending += bounty;
        pendingWithdrawals[t.creator] += bounty;

        emit TaskCancelled(taskId, t.creator, bounty);
        emit TaskFinalized(taskId, t.resultHash, uint8(Outcome.Cancelled));
    }

    /**
     * @notice Lock in a report hash without revealing it.
     * @dev The commitment binds to msg.sender, so replaying another verifier's
     *      commitment is accepted here but can never be revealed
     *      (threat model, "a verifier copies another verifier's answer").
     */
    function commitReport(bytes32 taskId, bytes32 commitment) external whenNotPaused {
        Task storage t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound();
        if (t.status != TaskStatus.Open && t.status != TaskStatus.Committing) revert InvalidStatus();
        if (block.timestamp > t.commitDeadline) revert CommitClosed();
        if (commitment == bytes32(0)) revert CommitmentMismatch();

        VerifierRecord storage v = _verifiers[msg.sender];
        if (!v.registered || !v.approved || !v.active) revert VerifierNotActive();

        Report storage r = _reports[taskId][msg.sender];
        if (r.commitment != bytes32(0)) revert AlreadyCommitted();
        if (t.committedCount >= t.verifierCount) revert TooManyCommitments();

        r.verifier = msg.sender;
        r.commitment = commitment;
        r.committedAt = uint32(block.timestamp);
        _taskVerifiers[taskId].push(msg.sender);
        t.committedCount += 1;
        if (t.status == TaskStatus.Open) t.status = TaskStatus.Committing;

        emit ReportCommitted(taskId, msg.sender, commitment);
    }

    /**
     * @notice Publish the report a commitment was made over.
     * @dev The anti-copying property lives in the second check: while a commit
     *      slot is still open and the commit window is still running, nothing
     *      may be revealed, so no pointer is readable until every verifier has
     *      committed or the window has closed on them.
     */
    function revealReport(bytes32 taskId, bytes32 reportHash, string calldata reportPointer, bytes32 salt)
        external
        whenNotPaused
    {
        Task storage t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound();
        if (t.status != TaskStatus.Committing && t.status != TaskStatus.Revealing) revert InvalidStatus();
        if (t.committedCount < t.verifierCount && block.timestamp <= t.commitDeadline) revert RevealNotOpen();
        if (block.timestamp > t.revealDeadline) revert DeadlinePassed();
        if (bytes(reportPointer).length > MAX_POINTER_BYTES) revert PointerTooLong();
        // `revealed` is a boolean the verifier sets by revealing, and the conflict
        // rate pays on it alone. A verifier that fetched nothing, ran nothing and
        // uploaded nothing could commit to `keccak(taskId, self, 0, 0)`, reveal an
        // empty report, and be paid exactly what a verifier that did the work is
        // paid. A reveal has to at least name content that can be fetched and
        // hash-checked; whether it is any good is what the consensus engine and
        // the dispute path are for.
        if (reportHash == bytes32(0) || bytes(reportPointer).length == 0) revert EmptyArtifact();

        Report storage r = _reports[taskId][msg.sender];
        if (r.commitment == bytes32(0)) revert NotRevealer();
        if (r.revealed) revert AlreadyRevealed();
        if (computeCommitment(taskId, msg.sender, reportHash, salt) != r.commitment) revert CommitmentMismatch();

        r.revealed = true;
        r.reportHash = reportHash;
        r.reportPointer = reportPointer;
        r.revealedAt = uint32(block.timestamp);
        t.revealedCount += 1;
        if (t.status == TaskStatus.Committing) t.status = TaskStatus.Revealing;

        emit ReportRevealed(taskId, msg.sender, reportHash, reportPointer);
    }

    /**
     * @notice Classify a finished reveal round and allocate the escrow.
     * @dev The keeper picks a classification, never an amount. Every branch
     *      derives its payouts from the outcome and from who actually revealed:
     *      Consensus splits `rewardBps` of the bounty over a duplicate-free set
     *      of revealed verifiers, Conflict pays `conflictRateBps` to everyone
     *      who revealed, NoQuorum refunds. Conflict and NoQuorum take no
     *      beneficiaries at all — the keeper names nobody on those paths, which
     *      is how the live deployment was driven too. Anything the bounty does
     *      not cover returns to the creator, so the task's escrow is fully
     *      accounted for in one pass.
     */
    function finalizeConsensus(
        bytes32 taskId,
        bytes32 resultHash,
        uint8 outcome,
        address[] calldata beneficiaries,
        uint16 rewardBps
    ) external onlyRole(KEEPER_ROLE) {
        Task storage t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound();
        if (t.status != TaskStatus.Open && t.status != TaskStatus.Committing && t.status != TaskStatus.Revealing) {
            revert InvalidStatus();
        }
        if (t.revealedCount < t.verifierCount && block.timestamp <= t.revealDeadline) revert RevealNotClosed();
        if (outcome == uint8(Outcome.None) || outcome > uint8(Outcome.NoQuorum)) revert InvalidOutcome();

        uint256 bounty = t.bounty;
        uint16 storedBps;

        if (outcome == uint8(Outcome.Consensus)) {
            // Pinned, not merely bounded. The trust model this contract is
            // deployed under says the keeper "chooses a classification, never an
            // amount", and an upper bound alone left it choosing the amount: any
            // value below 10000 pays the verifiers who reached a genuine
            // consensus less than the bounty and returns the difference to the
            // creator, with `rewardBps = 0` paying them nothing at all. The
            // keeper has always sent 10000, so nothing legitimate changes.
            //
            // This narrows the keeper's discretion without eliminating it:
            // misclassifying a consensus as Conflict or NoQuorum still underpays,
            // which the threat model names as an accepted residual that the
            // dispute path exists to answer.
            if (rewardBps != BPS_DENOMINATOR) revert InvalidRewardBps();
            if (beneficiaries.length == 0) revert InvalidBeneficiary();
            storedBps = rewardBps;

            uint256 paid = _splitAmong(taskId, beneficiaries, bounty * rewardBps / BPS_DENOMINATOR);
            _allocate(taskId, t.creator, bounty - paid);
        } else if (outcome == uint8(Outcome.Conflict)) {
            if (beneficiaries.length != 0) revert InvalidBeneficiary();
            _allocate(taskId, t.creator, bounty - _payRevealers(taskId, bounty * params.conflictRateBps / BPS_DENOMINATOR, address(0)));
        } else {
            if (beneficiaries.length != 0) revert InvalidBeneficiary();
            _allocate(taskId, t.creator, bounty);
        }

        t.resultHash = resultHash;
        t.outcome = Outcome(outcome);
        t.rewardBps = storedBps;
        t.consensusAt = uint32(block.timestamp);
        t.status = TaskStatus.Consensus;

        emit ConsensusReached(taskId, resultHash, outcome, storedBps, uint32(_disputeDeadline(t)));
    }

    /**
     * @notice Contest a consensus during its dispute window.
     * @dev Restricted to the task's own parties — the creator or a verifier
     *      that committed — and bonded at exactly `challengeBondBps` of the
     *      bounty, which is the sybil cost for opening one.
     */
    // Deliberately not `whenNotPaused`. PAUSER_ROLE is granted to the admin, and
    // on a single-key deployment that is the keeper — so pausing let the party a
    // challenge exists to check censor the check itself, while `_disputeDeadline`
    // kept running on wall-clock time and closed the window for good. A challenge
    // only moves a bond into escrow, and every path that returns it stays open.
    function openChallenge(bytes32 taskId, bytes32 evidenceHash, string calldata evidencePointer)
        external
        payable
    {
        Task storage t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound();
        if (t.status != TaskStatus.Consensus) revert InvalidStatus();
        if (block.timestamp > _disputeDeadline(t)) revert DeadlinePassed();
        if (msg.sender != t.creator && _reports[taskId][msg.sender].commitment == bytes32(0)) revert NotAuthorized();
        // A task has exactly one dispute slot, first-come-first-served, and that
        // made the remedy monopolisable by the party it exists to check: a
        // verifier that knows its own report was fabricated could open a bogus
        // challenge the instant consensus landed, burn the slot, and let it
        // expire — the creator never gets to challenge at all. So the first half
        // of the window is the creator's alone.
        //
        // It stays symmetric. Where the harmed party is the verifiers rather than
        // the creator — a keeper that misclassified a genuine consensus — the
        // creator has no reason to challenge, lets its half pass, and the slot
        // reaches the verifiers with half the window still to run.
        if (msg.sender != t.creator && block.timestamp <= _creatorPriorityDeadline(t)) {
            revert WindowNotElapsed();
        }
        if (bytes(evidencePointer).length > MAX_POINTER_BYTES) revert PointerTooLong();
        // A challenge freezes every allocation on the task for the whole
        // adjudication window, so it has to point at something an adjudicator
        // can actually read.
        if (evidenceHash == bytes32(0) || bytes(evidencePointer).length == 0) revert EmptyArtifact();

        Dispute storage d = _disputes[taskId];
        if (d.challenger != address(0)) revert DisputeExists();
        if (msg.value != uint256(t.bounty) * params.challengeBondBps / BPS_DENOMINATOR) revert InsufficientBond();

        d.challenger = msg.sender;
        d.bond = uint96(msg.value);
        d.evidenceHash = evidenceHash;
        d.evidencePointer = evidencePointer;
        d.openedAt = uint32(block.timestamp);
        // `createTask` bounds its uint32 deadline casts and this one did not.
        uint256 adjudicationDeadline = block.timestamp + params.adjudicationWindow;
        if (adjudicationDeadline > type(uint32).max) revert InvalidWindow();
        d.deadline = uint32(adjudicationDeadline);
        t.status = TaskStatus.Disputed;

        _escrowed += msg.value;

        emit ChallengeOpened(taskId, msg.sender, evidenceHash);
    }

    /**
     * @notice Settle a dispute and finalize the task in one step.
     * @dev The adjudicator reallocates strictly inside what is already escrowed
     *      for this task — the bounty plus the bond — and can never be a
     *      beneficiary itself. An upheld challenge returns the bond, pays
     *      `challengerRewardBps` of the bounty on top, and re-splits what is
     *      left over the verifiers named; a rejected one leaves the consensus
     *      allocation exactly as it stands and only redistributes the forfeited
     *      bond. `reasonHash` replaces the task's result hash so the finalized
     *      task points at the adjudication record rather than the disputed one.
     */
    function resolveDispute(
        bytes32 taskId,
        bool upheld,
        bytes32 adjudicationHash,
        string calldata adjudicationPointer,
        address[] calldata beneficiaries,
        bytes32 reasonHash
    ) external onlyRole(ADJUDICATOR_ROLE) {
        Task storage t = _tasks[taskId];
        Dispute storage d = _disputes[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound();
        if (d.challenger == address(0)) revert DisputeNotFound();
        if (d.resolved) revert DisputeAlreadyResolved();
        if (t.status != TaskStatus.Disputed) revert InvalidStatus();
        if (bytes(adjudicationPointer).length > MAX_POINTER_BYTES) revert PointerTooLong();
        // `_requireRevealedSet` refuses to pay the caller through the beneficiary
        // array, but the challenger is paid directly by `_settleUpheld` and never
        // passes through it. Without this an adjudicator could open a challenge
        // on its own key and uphold it, taking its bond back plus
        // `challengerRewardBps` of the bounty — the exact self-payment the
        // beneficiary guard exists to prevent, through the one door it does not
        // cover. The adjudicator role is meant to arbitrate a dispute, never to
        // be a party to one.
        if (d.challenger == msg.sender) revert NotAuthorized();

        if (upheld) {
            _settleUpheld(taskId, beneficiaries);
            // The task's verdict has to move with its money. `_settleUpheld`
            // calls `_reclaimAll`, which unwinds every allocation the original
            // settlement made, so leaving `outcome` at Consensus and `rewardBps`
            // at the split that no longer pays anyone leaves the chain — and the
            // indexer and UI that read it, where Finalized + Consensus renders as
            // VERIFIED — reporting an overturned claim as a successful one.
            t.outcome = Outcome.Conflict;
            t.rewardBps = 0;
        } else {
            // A rejected challenge leaves the original allocations standing, so
            // the outcome and split it recorded are still the accurate ones.
            _settleRejected(taskId, beneficiaries);
        }

        d.resolved = true;
        d.upheld = upheld;
        d.outcome = upheld ? DisputeOutcome.Upheld : DisputeOutcome.Rejected;
        d.adjudicationHash = adjudicationHash;
        d.adjudicationPointer = adjudicationPointer;

        t.resultHash = reasonHash;
        t.status = TaskStatus.Finalized;

        emit DisputeResolved(taskId, upheld, adjudicationHash, adjudicationPointer);
        emit TaskFinalized(taskId, reasonHash, uint8(t.outcome));
    }

    /// @notice Close a task whose dispute window passed with no challenge. Permissionless.
    function finalizeTask(bytes32 taskId) external {
        _finalize(taskId);
    }

    /**
     * @notice Settle a task the keeper never classified. Permissionless once
     *         the reveal deadline has passed.
     * @dev Verifiers that revealed are paid the conflict rate and the rest goes
     *      back to the creator, so a keeper going offline delays settlement but
     *      cannot trap it (runbook, "the keeper is offline").
     */
    function expireTask(bytes32 taskId) external {
        Task storage t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound();
        if (t.status != TaskStatus.Open && t.status != TaskStatus.Committing && t.status != TaskStatus.Revealing) {
            revert InvalidStatus();
        }
        // `revealDeadline + keeperGracePeriod`, which is what the Params natspec
        // has always promised and what the threat model relies on.
        //
        // An earlier revision dropped the grace to match the surviving 2024
        // deployment, bisected from its historical state. That deployment is not
        // the one this source builds, and the grace is load-bearing: without it
        // `expireTask` and `finalizeConsensus` unlock in the same second, because
        // finalize only requires `block.timestamp > revealDeadline` once the
        // reveal set is short. Any task with an unfilled verifier slot could then
        // be raced — the creator front-runs the keeper, `_payRevealers` hands the
        // verifiers who did the work `conflictRateBps` (half) instead of the full
        // bounty a genuine consensus earns them, the rest returns to the creator,
        // and the terminal `Expired` status forecloses the dispute window that is
        // the only remedy for exactly this. The grace gives the keeper an
        // exclusive window to classify before anyone may expire the task.
        if (block.timestamp <= uint256(t.revealDeadline) + params.keeperGracePeriod) {
            revert DeadlineNotPassed();
        }

        uint256 bounty = t.bounty;
        uint256 paid;
        if (t.revealedCount > 0) {
            paid = _payRevealers(taskId, bounty * params.conflictRateBps / BPS_DENOMINATOR, address(0));
            t.outcome = Outcome.Conflict;
        } else {
            // Confirmed on chain: the live expiry of a task nobody revealed on
            // stored 4, not NoQuorum's 3.
            t.outcome = Outcome.Expired;
        }
        _allocate(taskId, t.creator, bounty - paid);

        t.status = TaskStatus.Expired;
        emit TaskFinalized(taskId, t.resultHash, uint8(t.outcome));
    }

    /**
     * @notice Return an unanswered challenge's bond and finalize on the original
     *         consensus. Permissionless once the adjudication window passes.
     */
    function expireDispute(bytes32 taskId) external {
        Task storage t = _tasks[taskId];
        Dispute storage d = _disputes[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound();
        if (d.challenger == address(0)) revert DisputeNotFound();
        if (d.resolved) revert DisputeAlreadyResolved();
        if (t.status != TaskStatus.Disputed) revert InvalidStatus();
        if (block.timestamp <= d.deadline) revert WindowNotElapsed();

        d.resolved = true;
        d.outcome = DisputeOutcome.Expired;
        // An unanswered challenge is not free. It froze every allocation on this
        // task for the whole adjudication window, so the verifiers it froze keep
        // a slice of the bond and only the rest returns. A full refund made the
        // bond a free option: open a challenge with no intention of pursuing it,
        // deny the payout for the window, and take the bond back at the end.
        uint256 forfeited = uint256(d.bond) * params.adjudicatorSplitBps / BPS_DENOMINATOR;
        uint256 compensated = _payRevealers(taskId, forfeited, d.challenger);
        _allocate(taskId, d.challenger, uint256(d.bond) - compensated);

        t.status = TaskStatus.Finalized;
        emit TaskFinalized(taskId, t.resultHash, uint8(t.outcome));
    }

    /// @notice Move this task's allocation into the caller's withdrawable balance.
    function claimReward(bytes32 taskId) external {
        _claim(taskId, msg.sender);
    }

    /// @notice The creator's side of claimReward, kept separate for call-site clarity.
    /**
     * @notice Sweeps this task's allocation, if it has one, and pays out the
     * creator's entire pending balance — not this task's share of it. The
     * taskId names the call, not the amount.
     */
    function refundCreator(bytes32 taskId) external nonReentrant {
        Task storage t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound();
        if (msg.sender != t.creator) revert NotAuthorized();

        if (_allocations[taskId][msg.sender] != 0) _claim(taskId, msg.sender);

        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToClaim();

        pendingWithdrawals[msg.sender] = 0;
        _pending -= amount;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit RefundClaimed(taskId, msg.sender, amount);
    }

    /// @notice Pull the caller's whole balance. The only path that sends ether.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        pendingWithdrawals[msg.sender] = 0;
        _pending -= amount;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /* ── verifier registry ────────────────────────────────────────────────── */

    /**
     * @notice Self-service registration. Approval is a separate, admin-only step
     *         — the MVP's sybil mitigation is an allow-list (PRD §15).
     */
    function registerVerifier(bytes32 metadataHash, string calldata metadataPointer) external payable whenNotPaused {
        if (bytes(metadataPointer).length > MAX_POINTER_BYTES) revert PointerTooLong();

        VerifierRecord storage v = _verifiers[msg.sender];
        uint256 stake = uint256(v.stake) + msg.value;
        if (stake > type(uint96).max) revert InvalidBounty();
        if (stake < params.minVerifierStake) revert InsufficientStake();

        if (!v.registered) {
            v.registered = true;
            v.active = true;
        }
        v.stake = uint96(stake);
        v.metadataHash = metadataHash;
        v.metadataPointer = metadataPointer;

        _staked += msg.value;

        emit VerifierRegistered(msg.sender, metadataHash, metadataPointer, stake);
    }

    /// @notice A verifier taking itself out of, or back into, the pool.
    function setVerifierActive(bool active) external {
        VerifierRecord storage v = _verifiers[msg.sender];
        if (!v.registered) revert NotRegistered();
        v.active = active;
        emit VerifierActiveSet(msg.sender, active);
    }

    function setVerifierApproval(address verifier, bool approved) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _verifiers[verifier].approved = approved;
        emit VerifierApprovalSet(verifier, approved);
    }

    /// @notice Withdraw stake into the caller's pending balance. Not blocked by pause.
    function withdrawStake(uint256 amount) external {
        VerifierRecord storage v = _verifiers[msg.sender];
        if (amount == 0 || amount > v.stake) revert InsufficientStake();
        // `registerVerifier` enforces `minVerifierStake` on the way in; without the
        // same floor on the way out an approved verifier can register, be approved,
        // withdraw everything, and keep committing with nothing at stake.
        uint256 remaining = uint256(v.stake) - amount;
        if ((v.approved || v.active) && remaining < params.minVerifierStake) revert InsufficientStake();

        v.stake = uint96(remaining);
        _staked -= amount;
        _pending += amount;
        pendingWithdrawals[msg.sender] += amount;
        emit StakeWithdrawn(msg.sender, amount, remaining);
    }

    /* ── admin ────────────────────────────────────────────────────────────── */

    function pause() external onlyRole(PAUSER_ROLE) {
        paused = true;
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        paused = false;
    }

    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grant(role, account);
    }

    /// @dev Deliberately silent: the deployed ABI has RoleGranted and no
    ///      RoleRevoked, so a revocation is observed by re-reading hasRole.
    function revokeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // An admin may not revoke its own admin role. DEFAULT_ADMIN_ROLE can only
        // be granted by a holder of it, so on the single-key deployment this call
        // is a one-way door: no verifier could ever be approved again, no role
        // granted, no pause lifted, and no recovery path exists at any price.
        // Rotation still works in the order the runbook gives — grant the
        // successor first, then have the successor revoke the old key.
        if (role == DEFAULT_ADMIN_ROLE && account == msg.sender) revert NotAuthorized();
        _roles[role][account] = false;
    }

    /* ── views ────────────────────────────────────────────────────────────── */

    function getTask(bytes32 taskId) external view returns (Task memory task) {
        return _tasks[taskId];
    }

    function getReport(bytes32 taskId, address verifier) external view returns (Report memory report) {
        return _reports[taskId][verifier];
    }

    function getVerifier(address verifier) external view returns (VerifierRecord memory record) {
        return _verifiers[verifier];
    }

    function getDispute(bytes32 taskId) external view returns (Dispute memory dispute) {
        return _disputes[taskId];
    }

    function getTaskVerifiers(bytes32 taskId) external view returns (address[] memory verifiers) {
        return _taskVerifiers[taskId];
    }

    function allocationOf(bytes32 taskId, address account) external view returns (uint256 amount) {
        return _allocations[taskId][account];
    }

    function hasRole(bytes32 role, address account) external view returns (bool ok) {
        return _roles[role][account];
    }

    /// @notice Everything the contract owes. `address(this).balance` must never be less.
    function totalLiabilities() external view returns (uint256 total) {
        return _escrowed + _allocated + _pending + _staked;
    }

    /// @dev keccak256(abi.encode(taskId, verifier, reportHash, salt)) — pinned
    ///      against six live commitments in packages/chain-client.
    function computeCommitment(bytes32 taskId, address verifier, bytes32 reportHash, bytes32 salt)
        public
        pure
        returns (bytes32 commitment)
    {
        return keccak256(abi.encode(taskId, verifier, reportHash, salt));
    }

    /* ── internals ────────────────────────────────────────────────────────── */

    function _grant(bytes32 role, address account) private {
        if (!_roles[role][account]) {
            _roles[role][account] = true;
            emit RoleGranted(role, account);
        }
    }

    function _disputeDeadline(Task storage t) private view returns (uint256) {
        return uint256(t.consensusAt) + t.disputeWindow;
    }

    /**
     * Until this passes only the creator may challenge. Half the task's own
     * window rather than a protocol constant, so it scales with what the creator
     * chose at `createTask` — a creator that wants a long look picks a long
     * `disputeWindowSec`, and a 30-second window gives both sides 15 seconds
     * because that is what it asked for.
     */
    function _creatorPriorityDeadline(Task storage t) private view returns (uint256) {
        return uint256(t.consensusAt) + t.disputeWindow / 2;
    }

    /**
     * Moves escrow into a per-task allocation. Allocations are provisional
     * until the task is terminal, which is what lets an upheld dispute unwind
     * them without ever touching the contract's balance.
     */
    function _allocate(bytes32 taskId, address to, uint256 amount) private {
        if (amount == 0) return;
        _allocations[taskId][to] += amount;
        _escrowed -= amount;
        _allocated += amount;
        emit RewardAllocated(taskId, to, amount);
    }

    /// Returns every allocation on this task to escrow and reports the total.
    function _reclaimAll(bytes32 taskId) private returns (uint256 total) {
        address[] storage vs = _taskVerifiers[taskId];
        for (uint256 i; i < vs.length; ++i) {
            total += _reclaim(taskId, vs[i]);
        }
        total += _reclaim(taskId, _tasks[taskId].creator);
        total += _reclaim(taskId, _disputes[taskId].challenger);
    }

    function _reclaim(bytes32 taskId, address account) private returns (uint256 amount) {
        amount = _allocations[taskId][account];
        if (amount == 0) return 0;
        _allocations[taskId][account] = 0;
        _allocated -= amount;
        _escrowed += amount;
        emit RewardReclaimed(taskId, account, amount);
    }

    /**
     * An upheld challenge unwinds the consensus split — it was wrong by
     * definition — and re-derives the whole task pool: the challenger gets its
     * bond back plus `challengerRewardBps` of the bounty, and what is left is
     * split over the verifiers the adjudication named.
     */
    function _settleUpheld(bytes32 taskId, address[] calldata beneficiaries) private {
        Task storage t = _tasks[taskId];
        uint256 bond = _disputes[taskId].bond;
        uint256 pool = _reclaimAll(taskId) + bond;
        uint256 toChallenger = bond + uint256(t.bounty) * params.challengerRewardBps / BPS_DENOMINATOR;
        uint256 remainder = pool - toChallenger;

        _allocate(taskId, t.creator, remainder - _splitAmong(taskId, beneficiaries, remainder));
        _allocate(taskId, _disputes[taskId].challenger, toChallenger);
    }

    /**
     * A rejected challenge leaves the consensus allocation untouched and only
     * disposes of the forfeited bond, so a failed challenge can never move the
     * bounty itself.
     */
    function _settleRejected(bytes32 taskId, address[] calldata beneficiaries) private {
        address challenger = _disputes[taskId].challenger;
        uint256 bond = _disputes[taskId].bond;
        uint256 defended = bond * params.adjudicatorSplitBps / BPS_DENOMINATOR;
        // The forfeited bond compensates the verifiers the challenge defamed. A
        // challenger that also revealed on this task is not one of them, and
        // paying it a share would refund part of the forfeit it just lost.
        for (uint256 i; i < beneficiaries.length; ++i) {
            if (beneficiaries[i] == challenger) revert InvalidBeneficiary();
        }
        uint256 paid = beneficiaries.length != 0
            ? _splitAmong(taskId, beneficiaries, defended)
            : _payRevealers(taskId, defended, challenger);

        _allocate(taskId, _tasks[taskId].creator, bond - paid);
    }

    /// Splits `pool` evenly over a validated beneficiary set; returns what it paid.
    function _splitAmong(bytes32 taskId, address[] calldata beneficiaries, uint256 pool)
        private
        returns (uint256 paid)
    {
        if (beneficiaries.length == 0) return 0;
        _requireRevealedSet(taskId, beneficiaries);

        uint256 share = pool / beneficiaries.length;
        for (uint256 i; i < beneficiaries.length; ++i) {
            _allocate(taskId, beneficiaries[i], share);
        }
        return share * beneficiaries.length;
    }

    /**
     * Splits `pool` evenly over everyone who revealed, skipping `exclude`, and
     * returns what it paid. The exclusion exists because a rejected challenger
     * that also revealed on the task would otherwise be paid a share of its own
     * forfeited bond — the forfeit is meant to compensate the verifiers it froze,
     * not to refund the challenger. Pass `address(0)` where nobody is excluded.
     */
    function _payRevealers(bytes32 taskId, uint256 pool, address exclude) private returns (uint256 paid) {
        address[] storage vs = _taskVerifiers[taskId];

        uint256 eligible;
        for (uint256 i; i < vs.length; ++i) {
            if (_reports[taskId][vs[i]].revealed && vs[i] != exclude) eligible += 1;
        }
        if (eligible == 0) return 0;

        uint256 share = pool / eligible;
        for (uint256 i; i < vs.length; ++i) {
            if (_reports[taskId][vs[i]].revealed && vs[i] != exclude) {
                _allocate(taskId, vs[i], share);
                paid += share;
            }
        }
    }

    /**
     * A caller-supplied beneficiary set is only ever accepted when every member
     * revealed on this task, no address appears twice, and none of them is the
     * caller. This is what stops a keeper or an adjudicator from paying itself,
     * paying a verifier that stayed silent, or draining a share by repeating one
     * address.
     *
     * The self-payment check is explicit rather than left to "revealed" doing
     * the work by accident. Nothing prevents the keeper or adjudicator key from
     * also being an approved verifier — the admin can approve one in a single
     * transaction — and such a key could otherwise name itself for the whole
     * bounty. A privileged caller that genuinely verified is still paid by the
     * derived paths (`Conflict` and `expireTask` pay every revealer the same
     * fixed rate); what it may not do is choose its own share.
     *
     * `msg.sender` alone was too narrow, because the roles are not one key by
     * necessity: a keeper could name the adjudicator, or an admin either of them.
     * No role holder may be a chosen beneficiary at all.
     *
     * What this cannot reach: an operator that controls a second address holding
     * no role. `setVerifierApproval` is admin-gated, so an admin can approve a
     * fresh EOA it also controls, have it commit and reveal, and name it here —
     * an onchain equality check cannot distinguish principals. Separating the
     * admin, keeper and adjudicator keys is what actually bounds that, and on the
     * live deployment they are one address. See docs/THREAT_MODEL.md.
     */
    function _requireRevealedSet(bytes32 taskId, address[] calldata beneficiaries) private view {
        uint256 n = beneficiaries.length;
        if (n == 0 || n > _tasks[taskId].verifierCount) revert InvalidBeneficiary();

        for (uint256 i; i < n; ++i) {
            address b = beneficiaries[i];
            if (b == msg.sender) revert InvalidBeneficiary();
            if (_roles[DEFAULT_ADMIN_ROLE][b] || _roles[KEEPER_ROLE][b] || _roles[ADJUDICATOR_ROLE][b]) {
                revert InvalidBeneficiary();
            }
            if (!_reports[taskId][b].revealed) revert NotRevealer();
            for (uint256 j; j < i; ++j) {
                if (beneficiaries[j] == b) revert DuplicateBeneficiary();
            }
        }
    }

    function _finalize(bytes32 taskId) private {
        Task storage t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound();
        if (t.status != TaskStatus.Consensus) revert InvalidStatus();
        if (block.timestamp <= _disputeDeadline(t)) revert WindowNotElapsed();

        t.status = TaskStatus.Finalized;
        emit TaskFinalized(taskId, t.resultHash, uint8(t.outcome));
    }

    function _claim(bytes32 taskId, address account) private {
        Task storage t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound();

        // A claim after an unchallenged dispute window finalizes on its own, so
        // no separate keeper transaction is needed to unlock a payout.
        if (t.status == TaskStatus.Consensus && block.timestamp > _disputeDeadline(t)) _finalize(taskId);

        TaskStatus status = t.status;
        if (status != TaskStatus.Finalized && status != TaskStatus.Expired && status != TaskStatus.Cancelled) {
            revert InvalidStatus();
        }

        uint256 amount = _allocations[taskId][account];
        if (amount == 0) revert NothingToClaim();

        _allocations[taskId][account] = 0;
        _allocated -= amount;
        _pending += amount;
        pendingWithdrawals[account] += amount;
    }
}
