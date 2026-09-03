// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProofRelay} from "../src/ProofRelay.sol";

/**
 * Cheatcodes used by the scripts. Declared here for the same reason the tests
 * declare theirs: this project builds with no Solidity libraries installed, so
 * forge-std's Script is not available.
 */
interface Vm {
    function envUint(string calldata name) external view returns (uint256);
    function envAddress(string calldata name) external view returns (address);
    function envOr(string calldata name, address defaultValue) external view returns (address);
    function addr(uint256 privateKey) external pure returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract Script {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;

    function _log(string memory label, address value) internal view {
        // The console is a no-op outside forge; its result is deliberately ignored.
        (bool ok,) = CONSOLE.staticcall(abi.encodeWithSignature("log(string,address)", label, value));
        ok;
    }

    function _warn(string memory message) internal view {
        (bool ok,) = CONSOLE.staticcall(abi.encodeWithSignature("log(string,string)", "WARNING", message));
        ok;
    }
}

/**
 * Deploys ProofRelay with the four roles separated (deployment doc, "Keys").
 *
 * The three role addresses come from the environment so a testnet run can point
 * them all at one key while a real deployment points `ADMIN_ADDRESS` at a
 * multisig. Each defaults to the broadcasting key, which keeps a bare
 * `forge script` working, but a deployment that means to separate the roles has
 * to say so explicitly.
 *
 *   PRIVATE_KEY=0x...  ADMIN_ADDRESS=0x...  KEEPER_ADDRESS=0x...  ADJUDICATOR_ADDRESS=0x... \
 *     forge script script/Deploy.s.sol:Deploy --rpc-url $OG_RPC_URL --broadcast
 *
 * Record the address it prints as PROOFRELAY_ADDRESS, and the block it landed
 * in as PROOFRELAY_DEPLOY_BLOCK — the indexer starts there instead of at
 * genesis, which on Galileo would be over 52 million blocks.
 */
contract Deploy is Script {

    function run() external returns (ProofRelay relay) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address admin = vm.envOr("ADMIN_ADDRESS", deployer);
        address keeper = vm.envOr("KEEPER_ADDRESS", deployer);
        address adjudicator = vm.envOr("ADJUDICATOR_ADDRESS", deployer);

        vm.startBroadcast(deployerKey);
        relay = new ProofRelay(admin, keeper, adjudicator);
        vm.stopBroadcast();

        _log("ProofRelay", address(relay));
        _log("admin", admin);
        _log("keeper", keeper);
        _log("adjudicator", adjudicator);

        // Collapsing the roles onto one key is fine for a testnet run and is not
        // fine for mainnet, so say it out loud at the moment it happens rather
        // than leaving it to a reader of the deployment doc. With one key the
        // beneficiary guard stops that key naming itself, but the same operator
        // can approve a second address it also controls and name that instead —
        // an onchain equality check cannot tell two keys of one principal apart.
        // Separating admin, keeper and adjudicator is what actually bounds it.
        if (admin == keeper || admin == adjudicator || keeper == adjudicator) {
            _warn("roles share a key - acceptable on testnet, not for mainnet");
        }
    }
}

/**
 * Adds a verifier to the allow-list, which is the MVP's sybil mitigation: a
 * verifier must self-register *and* be approved before it can commit
 * (deployment doc, step 3).
 *
 *   PROOFRELAY_ADDRESS=0x... VERIFIER_ADDRESS=0x... PRIVATE_KEY=0x... \
 *     forge script script/Deploy.s.sol:ApproveVerifier --rpc-url $OG_RPC_URL --broadcast
 *
 * The broadcasting key must hold DEFAULT_ADMIN_ROLE.
 */
contract ApproveVerifier is Script {
    function run() external {
        uint256 adminKey = vm.envUint("PRIVATE_KEY");
        ProofRelay relay = ProofRelay(vm.envAddress("PROOFRELAY_ADDRESS"));
        address verifier = vm.envAddress("VERIFIER_ADDRESS");

        vm.startBroadcast(adminKey);
        relay.setVerifierApproval(verifier, true);
        vm.stopBroadcast();

        _log("approved", verifier);
    }
}
