import { defineChain } from "viem";

/**
 * 0G Galileo testnet. Chain id 16602 — not the 80087 some older docs quote;
 * the value here is what `eth_chainId` really returns on
 * https://evmrpc-testnet.0g.ai.
 */
export const galileo = defineChain({
  id: 16602,
  name: "0G Galileo Testnet",
  nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
  rpcUrls: { default: { http: ["https://evmrpc-testnet.0g.ai"] } },
  blockExplorers: {
    default: { name: "0G ChainScan", url: "https://chainscan-galileo.0g.ai" },
  },
  testnet: true,
});

/**
 * 0G mainnet. Chain id 16661, confirmed against `eth_chainId` on
 * https://evmrpc.0g.ai — real value moves here, unlike Galileo.
 */
export const zeroGMainnet = defineChain({
  id: 16661,
  name: "0G Mainnet",
  nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
  rpcUrls: { default: { http: ["https://evmrpc.0g.ai"] } },
  blockExplorers: {
    default: { name: "0G ChainScan", url: "https://chainscan.0g.ai" },
  },
});

export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export const KNOWN_CHAINS = { 16602: galileo, 16661: zeroGMainnet, 31337: anvil } as const;

export interface NetworkInfo {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorer: string;
  storageExplorer: string;
  storageIndexer: string;
  faucet: string | null;
  symbol: string;
  /**
   * Nominal seconds per block. Anything that converts a duration the contract
   * measures in seconds into a block range — the adjudicator's dispute
   * lookback, for one — needs this, and it is not the same on both networks:
   * Galileo lands a block about every 2 s, mainnet about every 1 s. Reading
   * mainnet at Galileo's cadence halves the wall-clock span a lookback covers.
   */
  blockSeconds: number;
}

export const NETWORKS: Record<number, NetworkInfo> = {
  16602: {
    chainId: 16602,
    name: "0G Galileo testnet",
    rpcUrl: "https://evmrpc-testnet.0g.ai",
    explorer: "https://chainscan-galileo.0g.ai",
    storageExplorer: "https://storagescan-galileo.0g.ai",
    storageIndexer: "https://indexer-storage-testnet-turbo.0g.ai",
    faucet: "https://faucet.0g.ai",
    symbol: "0G",
    blockSeconds: 2,
  },
  16661: {
    chainId: 16661,
    name: "0G mainnet",
    rpcUrl: "https://evmrpc.0g.ai",
    explorer: "https://chainscan.0g.ai",
    storageExplorer: "https://storagescan.0g.ai",
    storageIndexer: "https://indexer-storage-turbo.0g.ai",
    // No faucet on mainnet: this is real value, and a null here is what stops
    // `doctor` from telling an operator to go and top up for free.
    faucet: null,
    symbol: "0G",
    blockSeconds: 1,
  },
  31337: {
    chainId: 31337,
    name: "Local anvil",
    rpcUrl: "http://127.0.0.1:8545",
    explorer: "",
    storageExplorer: "",
    storageIndexer: "",
    faucet: null,
    symbol: "ETH",
    blockSeconds: 1,
  },
};

export function networkInfo(chainId: number): NetworkInfo {
  return (
    NETWORKS[chainId] ?? {
      chainId,
      name: `chain ${chainId}`,
      rpcUrl: "",
      explorer: "",
      storageExplorer: "",
      storageIndexer: "",
      faucet: null,
      symbol: "ETH",
      // The slower of the two real cadences: a lookback derived from this
      // covers more blocks than it needs, never fewer.
      blockSeconds: 2,
    }
  );
}

export function txUrl(chainId: number, txHash: string | null | undefined): string | null {
  const explorer = networkInfo(chainId).explorer;
  if (!explorer || !txHash) return null;
  return `${explorer}/tx/${txHash}`;
}

export function addressUrl(chainId: number, address: string | null | undefined): string | null {
  const explorer = networkInfo(chainId).explorer;
  if (!explorer || !address) return null;
  return `${explorer}/address/${address}`;
}
