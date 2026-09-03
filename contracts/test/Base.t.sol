// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProofRelay} from "../src/ProofRelay.sol";

/**
 * Cheatcodes and assertions, declared here rather than imported.
 *
 * `forge build` for this project must work with zero Solidity libraries
 * installed and no remappings, so forge-std is not available. Only the
 * cheatcodes the suite actually uses are declared; their signatures are the
 * ones the cheatcode address dispatches on, so they must stay verbatim.
 */
interface Vm {
    function warp(uint256 timestamp) external;
    function deal(address account, uint256 balance) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert() external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data) external;
    function assume(bool condition) external pure;
    function addr(uint256 privateKey) external pure returns (address);
    function label(address account, string calldata name) external;
    function chainId(uint256 id) external;
    function etch(address target, bytes calldata code) external;
}

contract Assertions {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertTrue(bool condition, string memory reason) internal pure {
        if (!condition) revert(reason);
    }

    function assertFalse(bool condition, string memory reason) internal pure {
        if (condition) revert(reason);
    }

    function assertEq(uint256 a, uint256 b, string memory reason) internal pure {
        if (a != b) revert(string.concat(reason, ": ", _u(a), " != ", _u(b)));
    }

    function assertEq(address a, address b, string memory reason) internal pure {
        if (a != b) revert(reason);
    }

    function assertEq(bytes32 a, bytes32 b, string memory reason) internal pure {
        if (a != b) revert(reason);
    }

    function assertEq(bool a, bool b, string memory reason) internal pure {
        if (a != b) revert(reason);
    }

    function assertGe(uint256 a, uint256 b, string memory reason) internal pure {
        if (a < b) revert(string.concat(reason, ": ", _u(a), " < ", _u(b)));
    }

    function assertLe(uint256 a, uint256 b, string memory reason) internal pure {
        if (a > b) revert(string.concat(reason, ": ", _u(a), " > ", _u(b)));
    }

    function _u(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) digits++;
        bytes memory out = new bytes(digits);
        for (uint256 v = value; v != 0; v /= 10) out[--digits] = bytes1(uint8(48 + v % 10));
        return string(out);
    }
}

/// A beneficiary that cannot be paid. Used to prove a bad receiver only ever blocks itself.
contract RevertingReceiver {
    receive() external payable {
        revert("no");
    }

    function claim(ProofRelay relay, bytes32 taskId) external {
        relay.claimReward(taskId);
    }

    function withdraw(ProofRelay relay) external {
        relay.withdraw();
    }
}

/// Re-enters withdraw() from the payout itself.
contract ReentrantReceiver {
    ProofRelay private immutable relay;
    bool private entered;

    constructor(ProofRelay relay_) {
        relay = relay_;
    }

    receive() external payable {
        if (!entered) {
            entered = true;
            relay.withdraw();
        }
    }

    function claim(bytes32 taskId) external {
        relay.claimReward(taskId);
    }

    function withdraw() external {
        relay.withdraw();
    }
}

/**
 * Shared fixture: a deployed contract, funded actors, two approved verifiers,
 * and helpers for driving a task through commit/reveal without repeating the
 * salt bookkeeping in every test.
 */
contract ProofRelayFixture is Assertions {
    ProofRelay internal relay;

    address internal admin = address(0xA11CE);
    address internal keeper = address(0xBEEF);
    address internal adjudicator = address(0xADD1);
    address internal creator = address(0xC0FFEE);
    address internal verifierA = address(0xA1);
    address internal verifierB = address(0xB2);
    address internal verifierC = address(0xC3);
    address internal stranger = address(0xDEAD);

    uint256 internal constant BOUNTY = 1 ether;
    uint32 internal constant COMMIT_WINDOW = 900;
    uint32 internal constant REVEAL_WINDOW = 900;
    uint32 internal constant DISPUTE_WINDOW = 900;

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        relay = new ProofRelay(admin, keeper, adjudicator);

        vm.deal(creator, 1_000 ether);
        vm.deal(verifierA, 10 ether);
        vm.deal(verifierB, 10 ether);
        vm.deal(verifierC, 10 ether);
        vm.deal(stranger, 10 ether);

        _enroll(verifierA);
        _enroll(verifierB);
    }

    function _enroll(address verifier) internal {
        vm.prank(verifier);
        relay.registerVerifier(keccak256(abi.encodePacked(verifier)), "0g://verifier");
        vm.prank(admin);
        relay.setVerifierApproval(verifier, true);
    }

    function _spec(uint32 verifierCount) internal pure returns (ProofRelay.TaskSpec memory) {
        return ProofRelay.TaskSpec({
            verifierCount: verifierCount,
            commitWindowSec: COMMIT_WINDOW,
            revealWindowSec: REVEAL_WINDOW,
            disputeWindowSec: DISPUTE_WINDOW,
            manifestHash: keccak256("manifest"),
            manifestPointer: "0g://manifest",
            ruleId: keccak256("majority-agreement-v1")
        });
    }

    function _createTask() internal returns (bytes32) {
        return _createTask(BOUNTY, 2);
    }

    function _createTask(uint256 bounty, uint32 verifierCount) internal returns (bytes32) {
        vm.prank(creator);
        return relay.createTask{value: bounty}(_spec(verifierCount));
    }

    function _salt(address verifier) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("salt", verifier));
    }

    function _reportHash(address verifier) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("report", verifier));
    }

    function _commit(bytes32 taskId, address verifier) internal {
        // The commitment is computed before the prank: an external call inside
        // the argument list would consume it and the commit would arrive from
        // this test contract instead of the verifier.
        bytes32 commitment = relay.computeCommitment(taskId, verifier, _reportHash(verifier), _salt(verifier));
        vm.prank(verifier);
        relay.commitReport(taskId, commitment);
    }

    function _reveal(bytes32 taskId, address verifier) internal {
        vm.prank(verifier);
        relay.revealReport(taskId, _reportHash(verifier), "0g://report", _salt(verifier));
    }

    /// A task with both verifiers committed and revealed, ready for the keeper.
    function _revealedTask() internal returns (bytes32 taskId) {
        taskId = _createTask();
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);
        _reveal(taskId, verifierA);
        _reveal(taskId, verifierB);
    }

    function _both() internal view returns (address[] memory set) {
        set = new address[](2);
        set[0] = verifierA;
        set[1] = verifierB;
    }

    function _one(address account) internal pure returns (address[] memory set) {
        set = new address[](1);
        set[0] = account;
    }

    function _none() internal pure returns (address[] memory set) {
        set = new address[](0);
    }

    /// A revealed task settled on agreement, paying the full bounty to both verifiers.
    function _consensusTask() internal returns (bytes32 taskId) {
        taskId = _revealedTask();
        vm.prank(keeper);
        relay.finalizeConsensus(taskId, keccak256("result"), 1, _both(), 10_000);
    }

    function _disputedTask() internal returns (bytes32 taskId) {
        taskId = _consensusTask();
        uint256 bond = _bond(BOUNTY);
        vm.prank(creator);
        relay.openChallenge{value: bond}(taskId, keccak256("evidence"), "0g://evidence");
    }

    function _bond(uint256 bounty) internal view returns (uint256) {
        (, uint16 challengeBondBps,,,,,,,,) = relay.params();
        return bounty * challengeBondBps / relay.BPS_DENOMINATOR();
    }

    function _status(bytes32 taskId) internal view returns (ProofRelay.TaskStatus) {
        return relay.getTask(taskId).status;
    }

    function _skipPastReveal(bytes32 taskId) internal {
        vm.warp(uint256(relay.getTask(taskId).revealDeadline) + 1);
    }

    function _skipPastDispute(bytes32 taskId) internal {
        ProofRelay.Task memory task = relay.getTask(taskId);
        vm.warp(uint256(task.consensusAt) + task.disputeWindow + 1);
    }
}
