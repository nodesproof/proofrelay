import { describe, expect, it } from "vitest";
import { Outcome, TaskStatus, displayStatus, displayTone } from "./task.js";

describe("displayStatus", () => {
  it("names a finalized task by how it settled", () => {
    expect(displayStatus(TaskStatus.Finalized, Outcome.Consensus)).toBe("VERIFIED");
    expect(displayStatus(TaskStatus.Finalized, Outcome.Conflict)).toBe("CONFLICT");
    expect(displayStatus(TaskStatus.Finalized, Outcome.NoQuorum)).toBe("NO QUORUM");
  });

  it("reserves DISPUTED for a challenge that is still on the table", () => {
    expect(displayStatus(TaskStatus.Disputed, Outcome.Consensus)).toBe("DISPUTED");
    expect(displayStatus(TaskStatus.Adjudication, Outcome.Consensus)).toBe("DISPUTED");
    // Verifiers disagreeing with nobody challenging is a conflict, not a dispute.
    expect(displayStatus(TaskStatus.Finalized, Outcome.Conflict)).not.toBe("DISPUTED");
  });

  it("keeps a task in review until the contract has settled it", () => {
    expect(displayStatus(TaskStatus.Consensus, Outcome.Conflict)).toBe("IN REVIEW");
    expect(displayStatus(TaskStatus.Revealing, Outcome.None)).toBe("IN REVIEW");
  });

  it("colours conflict like a dispute and no-quorum like the other endings without a result", () => {
    expect(displayTone("CONFLICT")).toBe("coral");
    expect(displayTone("NO QUORUM")).toBe("ink");
  });
});
