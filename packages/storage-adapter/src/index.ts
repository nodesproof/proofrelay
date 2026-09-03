import type { StorageConfig } from "@proofrelay/config";
import { LocalStorageAdapter } from "./local.js";
import { ZeroGStorageAdapter } from "./zerog.js";
import type { StorageAdapter } from "./types.js";

export * from "./types.js";
export { LocalStorageAdapter } from "./local.js";
export { ZeroGStorageAdapter } from "./zerog.js";

/**
 * The driver is chosen by configuration, not by probing: a demo that silently
 * fell back from 0G to the filesystem would still look healthy while proving
 * nothing about 0G, which is the opposite of what this product is for.
 */
export function createStorageAdapter(config: StorageConfig): StorageAdapter {
  if (config.driver === "zerog") {
    if (!config.privateKey) {
      throw new Error("STORAGE_DRIVER=zerog needs STORAGE_PRIVATE_KEY (it pays 0G Storage fees)");
    }
    return new ZeroGStorageAdapter({
      indexerRpc: config.indexerRpc,
      rpcUrl: config.rpcUrl,
      privateKey: config.privateKey,
      cacheRoot: config.root,
      gateways: config.gateways,
      maxObjectBytes: config.maxObjectBytes,
      readTimeoutMs: config.readTimeoutMs,
      uploadTimeoutMs: config.uploadTimeoutMs,
    });
  }
  return new LocalStorageAdapter(config.root);
}
