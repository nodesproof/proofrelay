import { loadConfig } from "@proofrelay/config";
import { createStorageAdapter } from "@proofrelay/storage-adapter";

const config = loadConfig();
console.log("driver:", config.storage.driver, "indexer:", config.storage.indexerRpc);
const storage = createStorageAdapter(config.storage);

console.log("health:", await storage.health());

const probe = {
  kind: "source-snapshot",
  schemaVersion: "1.0.0",
  producer: "proofrelay-live-check",
  sourceId: "probe-001",
  uri: "https://docs.0g.ai/",
  status: "OK",
  httpStatus: 200,
  contentType: "text/plain; charset=utf-8",
  headers: { "x-proofrelay-source": "probe" },
  text: `live storage probe ${process.argv[2] ?? ""}`,
  byteLength: 0,
  contentHash: "sha256:" + "0".repeat(64),
  truncated: false,
  error: null,
  retrievedAt: new Date().toISOString(),
};

const started = Date.now();
const stored = await storage.put("source-snapshot", probe);
console.log("uploaded:", stored);

const back = await storage.get(stored.pointer);
console.log("downloaded:", back.bytes.length, "bytes; hash match:", back.hash === stored.hash, "source:", back.source);
console.log("total ms:", Date.now() - started);
