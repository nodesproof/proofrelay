/**
 * The session store, which is the only thing standing between a bearer token
 * and the wrong address.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSession, forgetForeignSession, readSession, tokenFor, writeSession } from "./session";

const ALICE = "0x33d2b4aa407b450aff307f81fec812ff6cd26266";
const BOB = "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65";
const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const LATER = new Date(NOW + 3_600_000).toISOString();

function store(overrides: Record<string, unknown> = {}) {
  window.localStorage.setItem(
    "proofrelay.session.v1",
    JSON.stringify({ token: "tok", address: ALICE, expiresAt: LATER, ...overrides }),
  );
}

beforeEach(() => {
  const backing = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
    },
  });
});

describe("tokenFor", () => {
  it("hands the token to the address that signed for it", () => {
    store();
    expect(tokenFor(ALICE, NOW)).toBe("tok");
  });

  /**
   * The load-bearing case. `prepare` resolves the acting address from the
   * session before it reads `creator` from the body, so a token surviving an
   * account switch would file the next task under the previous address.
   */
  it("refuses to authenticate a different address", () => {
    store();
    expect(tokenFor(BOB, NOW)).toBeNull();
  });

  it("ignores EIP-55 casing", () => {
    store();
    expect(tokenFor("0x33D2B4AA407B450AFF307F81FEC812FF6CD26266", NOW)).toBe("tok");
  });

  it("sends nothing while no wallet is connected", () => {
    store();
    expect(tokenFor(undefined, NOW)).toBeNull();
  });
});

describe("readSession", () => {
  it("drops an expired token rather than letting every request 401", () => {
    store({ expiresAt: new Date(NOW - 1).toISOString() });
    expect(readSession(NOW)).toBeNull();
    expect(window.localStorage.getItem("proofrelay.session.v1")).toBeNull();
  });

  it("drops a row that is not a session", () => {
    window.localStorage.setItem("proofrelay.session.v1", "{not json");
    expect(readSession(NOW)).toBeNull();
    window.localStorage.setItem("proofrelay.session.v1", JSON.stringify({ token: 1 }));
    expect(readSession(NOW)).toBeNull();
  });

  it("drops a row whose address is not an address", () => {
    store({ address: "alice" });
    expect(readSession(NOW)).toBeNull();
  });

  it("survives a browser that refuses storage entirely", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {
          throw new Error("SecurityError");
        },
        removeItem: () => {
          throw new Error("SecurityError");
        },
      },
    });
    expect(readSession(NOW)).toBeNull();
    expect(() => writeSession({ token: "t", address: ALICE, expiresAt: LATER })).not.toThrow();
    expect(() => clearSession()).not.toThrow();
  });
});

describe("writeSession", () => {
  it("stores the address lowercased so a later comparison cannot turn on casing", () => {
    writeSession({ token: "tok", address: "0x33D2B4AA407B450AFF307F81FEC812FF6CD26266", expiresAt: LATER });
    expect(readSession(NOW)?.address).toBe(ALICE);
  });
});

describe("forgetForeignSession", () => {
  it("clears a session left behind by another account", () => {
    store();
    expect(forgetForeignSession(BOB, NOW)).toBe(true);
    expect(readSession(NOW)).toBeNull();
  });

  it("keeps the session of the account that is connected", () => {
    store();
    expect(forgetForeignSession(ALICE, NOW)).toBe(false);
    expect(readSession(NOW)).not.toBeNull();
  });

  /**
   * wagmi restores the last connection asynchronously, so every reload has a
   * first render with no address. Treating that as "another account" signed the
   * user out on every page load.
   */
  it("keeps the session while the wallet is still reconnecting", () => {
    store();
    expect(forgetForeignSession(undefined, NOW)).toBe(false);
    expect(readSession(NOW)).not.toBeNull();
  });
});
