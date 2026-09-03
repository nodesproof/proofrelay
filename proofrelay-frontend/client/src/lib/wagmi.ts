/**
 * The wallet layer: one 0G network, injected connectors only.
 *
 * Which network is a build-time choice, not a compiled-in constant. The UI
 * signs against whatever chain `VITE_CHAIN_ID` names, and everything derived
 * from it — RPC, explorer, the tip floor a write has to clear — comes from the
 * table below rather than being hardcoded per call site. The backend already
 * worked this way (`packages/chain-client/src/chains.ts`); this file is the
 * browser's copy of the same three rows, because the web app is a standalone
 * npm project and does not depend on the workspace packages.
 *
 * There is no WalletConnect project id for this deployment, so WalletConnect is
 * deliberately absent — the config carries the injected connector plus whatever
 * EIP-6963 providers the browser announces, and nothing else.
 *
 * wagmi persists the last connection in localStorage. That is wanted (the wallet
 * survives a reload) but it also means a wallet left on another chain comes back
 * still selected and still on that chain; useWallet() surfaces that as
 * isWrongNetwork rather than silently pretending it is on the right one.
 */
import { createConfig, http, injected } from "wagmi";
import { defineChain } from "viem";

interface NetworkInfo {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorer: string;
  storageExplorer: string;
  symbol: string;
  testnet: boolean;
  /**
   * The node's minimum priority fee. Galileo rejects anything under 2 gwei with
   * "transaction gas price below minimum: gas tip cap 1"; mainnet answers
   * eth_maxPriorityFeePerGas with a flat 4 gwei. Every write floors its
   * maxPriorityFeePerGas here, so this is the value used when the RPC's own
   * estimate is unavailable or lower.
   */
  minPriorityFeeWei: bigint;
  /** Poll at roughly the block cadence, not viem's 4 s default. */
  pollingIntervalMs: number;
}

/** chainId 16602 for Galileo — not the 80087 some older docs quote. */
const NETWORKS: Record<number, NetworkInfo> = {
  16602: {
    chainId: 16602,
    name: "0G Galileo Testnet",
    rpcUrl: "https://evmrpc-testnet.0g.ai",
    explorer: "https://chainscan-galileo.0g.ai",
    storageExplorer: "https://storagescan-galileo.0g.ai",
    symbol: "0G",
    testnet: true,
    minPriorityFeeWei: 2_000_000_000n,
    pollingIntervalMs: 5_000,
  },
  16661: {
    chainId: 16661,
    name: "0G Mainnet",
    rpcUrl: "https://evmrpc.0g.ai",
    explorer: "https://chainscan.0g.ai",
    storageExplorer: "https://storagescan.0g.ai",
    symbol: "0G",
    testnet: false,
    minPriorityFeeWei: 4_000_000_000n,
    pollingIntervalMs: 3_000,
  },
};

const DEFAULT_CHAIN_ID = 16602;

function readChainId(): number {
  const raw = import.meta.env.VITE_CHAIN_ID as string | undefined;
  const parsed = Number(raw);
  // An unknown id has no explorer and no tip floor, so it is refused here
  // rather than producing a UI that links nowhere and signs underpriced.
  if (!raw || !Number.isInteger(parsed) || !NETWORKS[parsed]) return DEFAULT_CHAIN_ID;
  return parsed;
}

const network = NETWORKS[readChainId()]!;

/** The network this build signs against. */
export const ACTIVE_CHAIN_ID = network.chainId;
export const ACTIVE_RPC_URL = (import.meta.env.VITE_OG_RPC_URL as string | undefined) || network.rpcUrl;
export const EXPLORER_URL = network.explorer;
export const STORAGE_EXPLORER_URL = network.storageExplorer;
export const NATIVE_SYMBOL = network.symbol;
/** Display name for UI copy — "switch to 0G Mainnet", banners, tooltips. */
export const NETWORK_NAME = network.name;
export const MIN_PRIORITY_FEE_WEI = network.minPriorityFeeWei;
export const CHAIN_POLLING_INTERVAL_MS = network.pollingIntervalMs;
export const IS_TESTNET = network.testnet;

export const activeChain = defineChain({
  id: network.chainId,
  name: network.name,
  nativeCurrency: { name: "0G", symbol: network.symbol, decimals: 18 },
  rpcUrls: { default: { http: [ACTIVE_RPC_URL] } },
  blockExplorers: { default: { name: "0G ChainScan", url: network.explorer } },
  testnet: network.testnet,
});

export const wagmiConfig = createConfig({
  chains: [activeChain],
  connectors: [injected({ shimDisconnect: true })],
  transports: { [activeChain.id]: http(ACTIVE_RPC_URL, { batch: true, retryCount: 3 }) },
  pollingInterval: CHAIN_POLLING_INTERVAL_MS,
  multiInjectedProviderDiscovery: true,
  ssr: false,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

export function explorerTxUrl(txHash: string | null | undefined): string | null {
  return txHash ? `${EXPLORER_URL}/tx/${txHash}` : null;
}

export function explorerAddressUrl(address: string | null | undefined): string | null {
  return address ? `${EXPLORER_URL}/address/${address}` : null;
}
