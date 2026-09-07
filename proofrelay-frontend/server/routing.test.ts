import { describe, expect, it } from "vitest";
import { looksLikeAsset } from "./routing.js";

describe("looksLikeAsset", () => {
  /**
   * The failure this exists for. Vite names output by content hash, so a client
   * rebuild replaces every asset filename. A server still holding the previous
   * index.html serves a page whose script tag points at a deleted file; the
   * catch-all answered it with the shell, so the browser got `<!doctype html>`
   * under a `.js` URL at status 200, failed to parse it as JavaScript, and
   * rendered nothing — with no error and no 404 anywhere to find.
   */
  it("catches the vite output a rebuild renames", () => {
    expect(looksLikeAsset("/assets/index-GnvPRTLN.js")).toBe(true);
    expect(looksLikeAsset("/assets/index-xbLNLqOg.css")).toBe(true);
  });

  /** Nothing under vite's output directory is ever a page, however named. */
  it("treats everything under /assets/ as a file", () => {
    expect(looksLikeAsset("/assets/anything-at-all")).toBe(true);
    expect(looksLikeAsset("/assets/nested/deep/thing")).toBe(true);
  });

  it("catches the loose files a shell references", () => {
    for (const path of ["/favicon.ico", "/favicon-32.png", "/apple-touch-icon.png", "/site.webmanifest", "/robots.txt"]) {
      expect(looksLikeAsset(path)).toBe(true);
    }
  });

  /**
   * The load-bearing half. Every one of these is a wouter route, and answering
   * any of them with a 404 would break the app far worse than the bug being
   * fixed — which is why the extension list is an allowlist and not "contains
   * a dot".
   */
  it("leaves every page route alone", () => {
    for (const path of [
      "/",
      "/tasks",
      "/task/0x88218974724cbd4e73528479ef3abc02289d131c6e110c4a05b2ddcd9261448c",
      "/verifiers",
      "/activity",
      "/artifacts",
      "/claims/v1.2",
      "/some.page.with.dots",
    ]) {
      expect(looksLikeAsset(path)).toBe(false);
    }
  });

  it("is not fooled by a dot in the wrong place", () => {
    expect(looksLikeAsset("/.hidden")).toBe(false);
    expect(looksLikeAsset("/trailing.")).toBe(false);
    expect(looksLikeAsset("/dir.js/page")).toBe(false);
  });

  it("ignores extension casing", () => {
    expect(looksLikeAsset("/logo.PNG")).toBe(true);
    expect(looksLikeAsset("/bundle.JS")).toBe(true);
  });

  it("does not claim an extension it has never heard of", () => {
    expect(looksLikeAsset("/report.pdf")).toBe(false);
    expect(looksLikeAsset("/thing.exe")).toBe(false);
  });
});
