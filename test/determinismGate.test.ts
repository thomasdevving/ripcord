import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let root: string, a: string, b: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ripcord-determinism-"));
  a = join(root, "a"); b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const write = (dir: string, file = "report.json", generatedAt = "first", outcome = "undetermined") =>
  writeFileSync(join(dir, file), JSON.stringify({ generatedAt, outcome }));
const compare = () => spawnSync(process.execPath, ["scripts/compare-reports.mjs", a, b], { encoding: "utf8" });

it("rejects an empty comparison", () => expect(compare().status).toBe(1));
it("rejects a report present only in B", () => {
  write(a); write(b); write(b, "extra.json");
  expect(compare().status).toBe(1);
});
it("rejects a missing report in B", () => {
  write(a);
  expect(compare().status).toBe(1);
});
it("accepts identical reports after normalizing generation time", () => {
  write(a); write(b, "report.json", "later");
  expect(compare().status).toBe(0);
});
it("still rejects a semantic difference", () => {
  write(a); write(b, "report.json", "later", "no_notice");
  expect(compare().status).toBe(1);
});
