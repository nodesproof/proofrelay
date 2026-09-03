import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Hex } from "viem";

export interface CommitRecord {
  taskId: Hex;
  reportHash: Hex;
  pointer: string;
  salt: Hex;
  createdAt: string;
  committedAt: string;
  txHash: string;
}

/**
 * What a verifier committed to, on disk.
 *
 * A commitment binds a specific reportHash, and a report's bytes include the
 * timestamp at which it was built — so a worker that crashed after committing
 * cannot simply rebuild the report and reveal it: the rebuild would carry a new
 * timestamp, hash differently, and its own reveal would revert with
 * CommitmentMismatch. It would forfeit a task it did honest work on.
 *
 * Making the timestamp fake to dodge that would be worse: the report would
 * claim a retrieval time that never happened. So the commitment is journalled
 * instead, and a restart reveals exactly what it promised.
 */
export class CommitJournal {
  private readonly path: string;
  private cache: Record<string, CommitRecord> | null = null;

  constructor(root: string, verifierId: string) {
    this.path = join(root, `${verifierId}-commits.json`);
  }

  /**
   * Only a journal that does not exist yet is an empty journal.
   *
   * Catching every error and returning `{}` meant one transient EIO, a bad
   * permission, or a half-written file was indistinguishable from a first run —
   * and the next `put()` flushed that empty object back over the file,
   * destroying the salts of every other commitment already on chain. Those
   * tasks can never be revealed. Failing loudly costs one crash-loop; failing
   * quietly costs every pending task at once.
   */
  private async load(): Promise<Record<string, CommitRecord>> {
    if (this.cache) return this.cache;

    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = {};
        return this.cache;
      }
      throw new Error(`the commit journal at ${this.path} could not be read: ${String(error)}`);
    }

    try {
      this.cache = JSON.parse(raw) as Record<string, CommitRecord>;
    } catch (error) {
      throw new Error(
        `the commit journal at ${this.path} is not valid JSON and must not be replaced: ${String(error)}`,
      );
    }
    return this.cache;
  }

  async get(taskId: Hex): Promise<CommitRecord | null> {
    const all = await this.load();
    return all[taskId.toLowerCase()] ?? null;
  }

  async put(record: CommitRecord): Promise<void> {
    const all = await this.load();
    all[record.taskId.toLowerCase()] = record;
    await this.flush(all);
  }

  async remove(taskId: Hex): Promise<void> {
    const all = await this.load();
    delete all[taskId.toLowerCase()];
    await this.flush(all);
  }

  async pending(): Promise<CommitRecord[]> {
    return Object.values(await this.load());
  }

  /** Written through a temp file: a torn journal loses every commitment at once. */
  private async flush(all: Record<string, CommitRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // rename() is atomic, but only against a file the OS has actually written.
    // Without the fsync the rename can land while the temp file's contents are
    // still in the page cache, so a power loss leaves an empty journal where a
    // complete one is supposed to be — the crash safety the comment promised
    // was the one case it did not cover. The directory is synced too, so the
    // rename itself survives. A pid-suffixed temp name keeps two workers sharing
    // a root from writing over each other.
    const tmp = `${this.path}.${process.pid}.tmp`;
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(`${JSON.stringify(all, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.path);

    const dir = await open(dirname(this.path), "r");
    try {
      await dir.sync();
    } catch {
      /* not every platform allows fsync on a directory */
    } finally {
      await dir.close();
    }
    this.cache = all;
  }
}
