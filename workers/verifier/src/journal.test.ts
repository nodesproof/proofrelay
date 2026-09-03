import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommitJournal } from "./journal.js";

const RECORD = {
  taskId: `0x${"a1".repeat(32)}` as const,
  reportHash: `0x${"b2".repeat(32)}` as const,
  pointer: "0g://report",
  salt: `0x${"c3".repeat(32)}` as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  committedAt: "2026-01-01T00:00:01.000Z",
  txHash: "0xdead",
};

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "proofrelay-journal-"));
}

describe("CommitJournal", () => {
  it("treats a journal that does not exist yet as empty", async () => {
    const journal = new CommitJournal(await root(), "verifier-a");
    expect(await journal.pending()).toEqual([]);
  });

  it("round-trips a commitment", async () => {
    const journal = new CommitJournal(await root(), "verifier-a");
    await journal.put(RECORD);
    expect(await journal.get(RECORD.taskId)).toEqual(RECORD);
  });

  /**
   * The salts in this file are the only way to reveal a commitment that is
   * already on chain. Swallowing a read failure and returning `{}` made one
   * transient error indistinguishable from a first run, and the next `put()`
   * flushed that empty object back over the file — every other pending task
   * loses its salt at once and can never be revealed.
   */
  it("refuses to treat an unreadable journal as an empty one", async () => {
    const dir = await root();
    const journal = new CommitJournal(dir, "verifier-a");
    await journal.put(RECORD);

    await writeFile(join(dir, "verifier-a-commits.json"), "{ not json", "utf8");

    const reopened = new CommitJournal(dir, "verifier-a");
    await expect(reopened.pending()).rejects.toThrow(/not valid JSON/);
  });

  it("does not overwrite a journal it could not read", async () => {
    const dir = await root();
    const path = join(dir, "verifier-a-commits.json");
    await new CommitJournal(dir, "verifier-a").put(RECORD);
    await writeFile(path, "{ not json", "utf8");

    const reopened = new CommitJournal(dir, "verifier-a");
    await expect(reopened.put({ ...RECORD, taskId: `0x${"ff".repeat(32)}` })).rejects.toThrow();

    // The corrupt file is still there for an operator to recover by hand.
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });
});
