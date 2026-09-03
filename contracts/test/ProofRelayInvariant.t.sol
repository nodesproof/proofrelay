// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProofRelay} from "../src/ProofRelay.sol";
import {Assertions} from "./Base.t.sol";

/**
 * Drives the contract through randomized action sequences while keeping a
 * shadow ledger of every wei that entered and left. Actions are wrapped in
 * try/catch so a rejected call does not abandon the sequence: the point is to
 * reach unusual orderings — a challenge on a task that expired, a claim before
 * finalization, a reveal after the window — not to assert that each individual
 * call succeeds.
 */
contract ProofRelayHandler is Assertions {
    ProofRelay public immutable relay;
    address public immutable creator;
    address public immutable verifierA;
    address public immutable verifierB;
    address public immutable keeper;
    address public immutable adjudicator;

    bytes32[] private _taskIds;

    /// Shadow ledger: what the contract received, and what it paid out.
    uint256 public deposited;
    uint256 public withdrawn;

    /// Per task: everything escrowed against it, and what has left its allocations.
    mapping(bytes32 => uint256) public escrowedFor;
    mapping(bytes32 => uint256) public claimedFrom;

    /// Counts of the transitions a sequence actually reached, so a run that
    /// never got past createTask is visible rather than silently vacuous.
    uint256 public reveals;
    uint256 public settlements;
    uint256 public disputes;
    uint256 public adjudications;
    uint256 public claims;
    uint256 public payouts;
    // Reachability counters for the settlement paths the walk below did not
    // cover. Without them an action that becomes unreachable — a guard tightened,
    // a status set the handler can no longer produce — leaves the invariants
    // asserting about states nothing ever enters, and the suite stays green.
    uint256 public expiries;
    uint256 public cancellations;
    uint256 public finalizations;
    uint256 public disputeExpiries;

    constructor(ProofRelay relay_, address creator_, address a, address b, address keeper_, address adjudicator_) {
        relay = relay_;
        creator = creator_;
        verifierA = a;
        verifierB = b;
        keeper = keeper_;
        adjudicator = adjudicator_;
    }

    function taskCount() external view returns (uint256) {
        return _taskIds.length;
    }

    function taskAt(uint256 index) external view returns (bytes32) {
        return _taskIds[index];
    }

    function _pick(uint256 seed) private view returns (bytes32) {
        return _taskIds[seed % _taskIds.length];
    }

    function _verifier(uint256 seed) private view returns (address) {
        return seed % 2 == 0 ? verifierA : verifierB;
    }

    function _actor(uint256 seed) private view returns (address) {
        uint256 which = seed % 3;
        if (which == 0) return creator;
        if (which == 1) return verifierA;
        return verifierB;
    }

    function _salt(bytes32 taskId, address verifier) private pure returns (bytes32) {
        return keccak256(abi.encode("salt", taskId, verifier));
    }

    function _hash(bytes32 taskId, address verifier) private pure returns (bytes32) {
        return keccak256(abi.encode("report", taskId, verifier));
    }

    function _revealed(bytes32 taskId) private view returns (address[] memory set) {
        address[] memory all = relay.getTaskVerifiers(taskId);
        uint256 n;
        set = new address[](all.length);
        for (uint256 i; i < all.length; ++i) {
            if (relay.getReport(taskId, all[i]).revealed) set[n++] = all[i];
        }
        assembly {
            mstore(set, n)
        }
    }

    /* ── actions ──────────────────────────────────────────────────────────── */

    /**
     * The task set is capped so a sequence keeps acting on the tasks it already
     * created. Without the cap almost every action lands on a fresh task and
     * the deep orderings — challenge, adjudication, expiry — are never reached.
     */
    uint256 private constant MAX_OPEN_TASKS = 3;

    function createTask(uint256 seed) external {
        if (_taskIds.length >= MAX_OPEN_TASKS) return;
        uint256 bounty = 1e14 + (seed % 5 ether);
        vm.deal(creator, creator.balance + bounty);

        ProofRelay.TaskSpec memory spec = ProofRelay.TaskSpec({
            verifierCount: 2,
            commitWindowSec: 600,
            revealWindowSec: 600,
            disputeWindowSec: 600,
            manifestHash: keccak256(abi.encode(seed)),
            manifestPointer: "0g://manifest",
            ruleId: keccak256("rule")
        });

        vm.prank(creator);
        try relay.createTask{value: bounty}(spec) returns (bytes32 taskId) {
            _taskIds.push(taskId);
            deposited += bounty;
            escrowedFor[taskId] += bounty;
        } catch {}
    }

    function commitReport(uint256 taskSeed, uint256 actorSeed) external {
        if (_taskIds.length == 0) return;
        bytes32 taskId = _pick(taskSeed);
        address verifier = _verifier(actorSeed);
        bytes32 commitment = relay.computeCommitment(taskId, verifier, _hash(taskId, verifier), _salt(taskId, verifier));

        vm.prank(verifier);
        try relay.commitReport(taskId, commitment) {} catch {}
    }

    function revealReport(uint256 taskSeed, uint256 actorSeed) external {
        if (_taskIds.length == 0) return;
        bytes32 taskId = _pick(taskSeed);
        address verifier = _verifier(actorSeed);

        vm.prank(verifier);
        try relay.revealReport(taskId, _hash(taskId, verifier), "0g://report", _salt(taskId, verifier)) {
            reveals += 1;
        } catch {}
    }

    function finalizeConsensus(uint256 taskSeed, uint256 outcomeSeed) external {
        if (_taskIds.length == 0) return;
        bytes32 taskId = _pick(taskSeed);
        uint8 outcome = uint8(1 + outcomeSeed % 3);
        address[] memory set = outcome == 1 ? _revealed(taskId) : new address[](0);

        vm.prank(keeper);
        try relay.finalizeConsensus(taskId, keccak256("result"), outcome, set, 10_000) {
            settlements += 1;
        } catch {}
    }

    function openChallenge(uint256 taskSeed, uint256 actorSeed) external {
        if (_taskIds.length == 0) return;
        bytes32 taskId = _pick(taskSeed);
        (, uint16 challengeBondBps,,,,,,,,) = relay.params();
        uint256 bond = uint256(relay.getTask(taskId).bounty) * challengeBondBps / 10_000;
        address who = actorSeed % 2 == 0 ? creator : verifierA;
        vm.deal(who, who.balance + bond);

        vm.prank(who);
        try relay.openChallenge{value: bond}(taskId, keccak256("evidence"), "0g://evidence") {
            deposited += bond;
            escrowedFor[taskId] += bond;
            disputes += 1;
        } catch {}
    }

    function resolveDispute(uint256 taskSeed, bool upheld) external {
        if (_taskIds.length == 0) return;
        bytes32 taskId = _pick(taskSeed);
        // Built before the prank: reading the revealed set is an external call,
        // and an external call in the argument list would consume the prank.
        address[] memory set = _revealed(taskId);

        vm.prank(adjudicator);
        try relay.resolveDispute(taskId, upheld, keccak256("adj"), "0g://adj", set, keccak256("why")) {
            adjudications += 1;
        } catch {}
    }

    function expireDispute(uint256 taskSeed) external {
        if (_taskIds.length == 0) return;
        try relay.expireDispute(_pick(taskSeed)) {
            disputeExpiries += 1;
        } catch {}
    }

    function finalizeTask(uint256 taskSeed) external {
        if (_taskIds.length == 0) return;
        try relay.finalizeTask(_pick(taskSeed)) {
            finalizations += 1;
        } catch {}
    }

    function expireTask(uint256 taskSeed) external {
        if (_taskIds.length == 0) return;
        try relay.expireTask(_pick(taskSeed)) {
            expiries += 1;
        } catch {}
    }

    function cancelTask(uint256 taskSeed) external {
        if (_taskIds.length == 0) return;
        bytes32 taskId = _pick(taskSeed);
        uint256 bounty = relay.getTask(taskId).bounty;

        vm.prank(creator);
        try relay.cancelTask(taskId) {
            cancellations += 1;
            // A cancellation credits the creator's pending balance directly
            // rather than allocating, so as far as the task's ledger is
            // concerned the bounty has already been claimed out of it.
            claimedFrom[taskId] += bounty;
        } catch {}
    }

    function refundCreator(uint256 taskSeed) external {
        if (_taskIds.length == 0) return;
        bytes32 taskId = _pick(taskSeed);
        uint256 allocation = relay.allocationOf(taskId, creator);
        uint256 pending = relay.pendingWithdrawals(creator);

        vm.prank(creator);
        try relay.refundCreator(taskId) {
            claimedFrom[taskId] += allocation;
            // It pays the creator's whole balance, including anything swept out
            // of this task on the way in.
            withdrawn += pending + allocation;
            payouts += 1;
        } catch {}
    }

    function claimReward(uint256 taskSeed, uint256 actorSeed) external {
        if (_taskIds.length == 0) return;
        bytes32 taskId = _pick(taskSeed);
        address who = _actor(actorSeed);
        uint256 allocation = relay.allocationOf(taskId, who);

        vm.prank(who);
        try relay.claimReward(taskId) {
            claimedFrom[taskId] += allocation;
            claims += 1;
        } catch {}
    }

    function withdraw(uint256 actorSeed) external {
        address who = _actor(actorSeed);
        uint256 amount = relay.pendingWithdrawals(who);

        vm.prank(who);
        try relay.withdraw() {
            withdrawn += amount;
            payouts += 1;
        } catch {}
    }

    function stake(uint256 actorSeed, uint256 amountSeed) external {
        address who = _verifier(actorSeed);
        uint256 amount = 1 + (amountSeed % 1 ether);
        vm.deal(who, who.balance + amount);

        vm.prank(who);
        try relay.registerVerifier{value: amount}(keccak256("meta"), "0g://meta") {
            deposited += amount;
        } catch {}
    }

    function unstake(uint256 actorSeed, uint256 amountSeed) external {
        address who = _verifier(actorSeed);
        uint256 held = relay.getVerifier(who).stake;
        if (held == 0) return;

        vm.prank(who);
        try relay.withdrawStake(1 + (amountSeed % held)) {} catch {}
    }

    function passTime(uint256 seed) external {
        vm.warp(block.timestamp + 1 + (seed % 5 days));
    }
}

contract ProofRelayInvariantTest is Assertions {
    ProofRelay internal relay;
    ProofRelayHandler internal handler;

    address internal admin = address(0xA11CE);
    address internal keeper = address(0xBEEF);
    address internal adjudicator = address(0xADD1);
    address internal creator = address(0xC0FFEE);
    address internal verifierA = address(0xA1);
    address internal verifierB = address(0xB2);

    function setUp() public {
        vm.warp(1_700_000_000);
        relay = new ProofRelay(admin, keeper, adjudicator);

        vm.prank(verifierA);
        relay.registerVerifier(keccak256("a"), "0g://a");
        vm.prank(verifierB);
        relay.registerVerifier(keccak256("b"), "0g://b");
        vm.prank(admin);
        relay.setVerifierApproval(verifierA, true);
        vm.prank(admin);
        relay.setVerifierApproval(verifierB, true);

        handler = new ProofRelayHandler(relay, creator, verifierA, verifierB, keeper, adjudicator);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    /// The escrow invariant from architecture doc §15.
    function invariant_BalanceCoversLiabilities() public view {
        assertGe(address(relay).balance, relay.totalLiabilities(), "contract is insolvent");
    }

    /// Nothing is minted and nothing leaks: the balance is exactly what came in minus what left.
    function invariant_ValueIsConserved() public view {
        assertEq(
            address(relay).balance, handler.deposited() - handler.withdrawn(), "balance diverged from the ledger"
        );
    }

    /// No task can ever allocate more than what was escrowed against it.
    function invariant_PerTaskAllocationsStayWithinEscrow() public view {
        uint256 count = handler.taskCount();
        for (uint256 i; i < count; ++i) {
            bytes32 taskId = handler.taskAt(i);
            assertLe(_outstanding(taskId), handler.escrowedFor(taskId), "task over-allocated");
        }
    }

    /// A settled task has accounted for every wei escrowed against it.
    function invariant_SettledTasksAreFullyAllocated() public view {
        uint256 count = handler.taskCount();
        for (uint256 i; i < count; ++i) {
            bytes32 taskId = handler.taskAt(i);
            ProofRelay.TaskStatus status = relay.getTask(taskId).status;
            if (
                status == ProofRelay.TaskStatus.Finalized || status == ProofRelay.TaskStatus.Expired
                    || status == ProofRelay.TaskStatus.Cancelled
            ) {
                assertEq(_outstanding(taskId), handler.escrowedFor(taskId), "settled task left escrow behind");
            }
        }
    }

    /**
     * An invariant suite is only as good as the states its handler can reach.
     * This walks the handler through the deepest path it has — create, commit,
     * reveal, settle, challenge, adjudicate, claim, withdraw — so a refactor
     * that silently makes an action unreachable fails here instead of turning
     * the invariants above into assertions about an empty contract.
     */
    function test_HandlerReachesEveryTransition() public {
        handler.createTask(1);
        handler.commitReport(0, 0);
        handler.commitReport(0, 1);
        handler.revealReport(0, 0);
        handler.revealReport(0, 1);
        handler.finalizeConsensus(0, 0);
        handler.openChallenge(0, 0);
        handler.resolveDispute(0, true);
        handler.claimReward(0, 1);
        handler.withdraw(1);

        assertEq(handler.reveals(), 2, "reveals unreachable");
        assertEq(handler.settlements(), 1, "settlement unreachable");
        assertEq(handler.disputes(), 1, "challenge unreachable");
        assertEq(handler.adjudications(), 1, "adjudication unreachable");
        assertEq(handler.claims(), 1, "claim unreachable");
        assertEq(handler.payouts(), 1, "withdrawal unreachable");

        // The settlement paths the walk above never touches. Each is reached on
        // its own task, because they are alternatives to the consensus path
        // rather than steps after it. Adding the grace period to expireTask made
        // exactly this action unreachable at the old timings, and the invariants
        // stayed green — which is what these assertions are here to stop.
        handler.createTask(2);
        handler.cancelTask(1);
        assertEq(handler.cancellations(), 1, "cancellation unreachable");

        handler.createTask(3);
        handler.commitReport(2, 0);
        // passTime caps a single jump under 5 days; the keeper grace is 3 and the
        // adjudication window is 7, so the longer waits take two.
        handler.passTime(5 days - 1);
        handler.passTime(5 days - 1);
        handler.expireTask(2);
        assertEq(handler.expiries(), 1, "expiry unreachable");

        // finalizeTask and expireDispute have counters but no assertion here:
        // both need a task carried to Consensus or Disputed and then past a
        // window, and building that through the handler's seeded picks is not
        // reliable enough to assert on. The counters make them observable, which
        // is what a future walk needs; the gap is deliberate, not forgotten.
    }

    function _outstanding(bytes32 taskId) private view returns (uint256) {
        return relay.allocationOf(taskId, creator) + relay.allocationOf(taskId, verifierA)
            + relay.allocationOf(taskId, verifierB) + handler.claimedFrom(taskId);
    }
}
