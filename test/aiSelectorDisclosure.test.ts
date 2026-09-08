import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AI_SIDECAR_REVIEW_MESSAGE } from "../server/shared/ai-disclosure.js";
import { AI_ARTIFACT_VERSION, parseArtifact, type AiForkRunRecord, type AiSelectorArtifact } from "../server/ai-selector/artifact.js";
import { decideDisclosure, projectPublicView, recoverOnBoot, triggersQuarantine, type AiSidecarRecord } from "../server/ai-selector/disclosure.js";
import { AiSidecarStore } from "../server/ai-selector/store.js";
import type { CandidateOutcome } from "../server/ai-selector/experiment.js";

const SELECTOR = "0x44c35d07";
const SIGNATURE = "pause(bool,bool,bool,bool,bool)";
const CALLER = "0x1111111111111111111111111111111111111111";

function outcome(status: string): CandidateOutcome {
  return {
    selector: SELECTOR, canonicalSignature: SIGNATURE, status: status as CandidateOutcome["status"],
    note: `n ${CALLER}`, gaps: [], confirmedBy: [{ label: "true,true,true,true,true", calldata: `${SELECTOR}ff` }], stepsRun: 32,
  };
}

function run(status: string, runId = "run-a"): AiForkRunRecord {
  return {
    forkIdentity: { runId, chainId: 1, blockNumber: "25800000", blockHash: "0xbb", targetCodeHash: "0xcc", planHash: "sha256:plan" },
    candidates: [outcome(status)],
    steps: [{
      selector: SELECTOR, canonicalSignature: SIGNATURE, label: "true,true,true,true,true", calldata: `${SELECTOR}ff`,
      branches: [{ branch: "controller", caller: CALLER, mutation: "succeeded", positionAfterMutation: null, exit: null }],
      classification: { status, note: `n ${CALLER}`, gaps: [], evaluations: [] } as never,
    }],
  };
}

function artifact(over: Partial<AiSelectorArtifact> = {}): AiSelectorArtifact {
  return {
    version: AI_ARTIFACT_VERSION,
    reportId: "rep_1", target: "0xaaaa", chainId: 1,
    block: { number: "25800000", hash: "0xbb" },
    scannedAddress: "0xaaaa", scannedCodeHash: "0xcc",
    requestedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:00.000Z",
    complete: true,
    model: { provider: "openai", name: "m", promptVersion: "v1", promptHash: "sha256:p", responseId: "r" },
    totalUnmatchedSelectors: 3, submittedSelectors: [SELECTOR],
    candidates: [{
      selector: SELECTOR, proposedSignature: SIGNATURE, canonicalSignature: SIGNATURE,
      capabilityHint: "pause_or_freeze", rationale: "hint", validationStatus: "selector_hash_matched",
      computedSelector: SELECTOR, inputTypes: ["bool", "bool", "bool", "bool", "bool"],
      booleanArgumentsEnumerable: true, arityCompatibility: "compatible_observed",
      behaviorStatus: "not_attempted", behaviorNote: "n",
    }],
    arity: [{
      selector: SELECTOR,
      arity: { status: "minimum_words_observed", minimumWords: 5, observations: [{ words: 0, outcome: "empty_revert" }], note: "n" },
      evidence: [{ kind: "call", params: { data: `${SELECTOR}0000`, from: CALLER }, rawValue: "0x", block: "25800000" }],
    }],
    plan: {
      version: "ai-selector-plan/0.1.0",
      plans: [{ selector: SELECTOR, canonicalSignature: SIGNATURE, inputTypes: [], priority: 70, exhaustive: true, steps: [{ label: "true,true,true,true,true", calldata: `${SELECTOR}ff` }], note: "n" }],
      skipped: [{ selector: "0xdeadbeef", canonicalSignature: null, reason: "untested, not cleared" }],
      totalSteps: 32, budgetExhausted: false, planHash: "sha256:plan",
    },
    runs: [run("effect_confirmed")],
    reproduction: { independent: true, gaps: [], candidates: [outcome("effect_confirmed")] },
    gaps: ["reachability not tested: no unattributed-caller branch was run"],
    ...over,
  };
}

describe("decideDisclosure", () => {
  it("publishes a complete run that observed nothing requiring review", () => {
    expect(decideDisclosure(artifact())).toMatchObject({ status: "publishable", location: "private" });
  });

  it("quarantines as soon as ONE fork sees an unattributed-caller restriction", () => {
    const decision = decideDisclosure(artifact({ runs: [run("unattributed_caller_restriction_observed")] }));
    expect(decision).toMatchObject({ status: "review_required", location: "quarantine" });
  });

  it("does not wait for independent reproduction before quarantining", () => {
    // The agreed view has already collapsed the unreproduced positive to
    // inconclusive. Reading THAT instead of the raw runs would publish it.
    const unreproduced = artifact({
      runs: [run("unattributed_caller_restriction_observed", "run-a"), run("no_exit_effect_observed", "run-b")],
      reproduction: { independent: true, gaps: ["disagreed"], candidates: [outcome("inconclusive")] },
    });
    expect(decideDisclosure(unreproduced).status).toBe("review_required");
  });

  it("quarantines on a step classification even if the candidate rollup lost it", () => {
    const sneaky = artifact({
      runs: [{ ...run("no_exit_effect_observed"), steps: run("unattributed_caller_restriction_observed").steps }],
    });
    expect(triggersQuarantine(sneaky)).toBe(true);
  });

  it("quarantine outranks incompleteness, so an interrupted run cannot hide an observation", () => {
    const partial = artifact({ complete: false, completedAt: null, runs: [run("unattributed_caller_restriction_observed")] });
    expect(decideDisclosure(partial).status).toBe("review_required");
  });

  it("refuses to publish an incomplete run", () => {
    expect(decideDisclosure(artifact({ complete: false })).status).toBe("unavailable");
    expect(decideDisclosure(artifact({ completedAt: null })).status).toBe("unavailable");
  });
});

describe("projectPublicView — review_required discloses nothing", () => {
  const record = (status: AiSidecarRecord["status"], location: AiSidecarRecord["artifactLocation"] = "private"): AiSidecarRecord =>
    ({ reportId: "rep_1", status, reason: "r", updatedAt: "t", artifactLocation: location });

  it("returns only the neutral message, with no selector, address, calldata or payload", () => {
    const quarantined = artifact({ runs: [run("unattributed_caller_restriction_observed")] });
    const view = projectPublicView(record("review_required", "quarantine"), quarantined);

    expect(view).toEqual({ status: "review_required", message: AI_SIDECAR_REVIEW_MESSAGE });
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(SELECTOR);
    expect(serialised).not.toContain(CALLER);
    expect(serialised).not.toContain(SIGNATURE);
    // Nothing selector- or address-shaped survives at all.
    expect(serialised).not.toMatch(/0x[0-9a-fA-F]{8}/);
  });

  it("re-runs the gate rather than trusting a stored publishable status", () => {
    // A record written by an older version, over an artifact that must not ship.
    const quarantined = artifact({ runs: [run("unattributed_caller_restriction_observed")] });
    expect(projectPublicView(record("publishable"), quarantined)).toEqual({ status: "review_required", message: AI_SIDECAR_REVIEW_MESSAGE });
  });

  it("degrades to unavailable when the artifact behind a publishable record is missing", () => {
    expect(projectPublicView(record("publishable"), null).status).toBe("unavailable");
  });

  it("says nothing but pending while a run is in flight", () => {
    const view = projectPublicView(record("pending_private", null), artifact());
    expect(view.status).toBe("pending_private");
    expect(JSON.stringify(view)).not.toContain(SELECTOR);
  });
});

describe("projectPublicView — the published shape", () => {
  const record: AiSidecarRecord = { reportId: "rep_1", status: "publishable", reason: "r", updatedAt: "t", artifactLocation: "private" };

  it("publishes candidate outcomes, budget, plan hash and reproduction status", () => {
    const view = projectPublicView(record, artifact());
    expect(view.status).toBe("publishable");
    if (view.status !== "publishable") return;

    expect(view.candidates[0]).toMatchObject({
      selector: SELECTOR, canonicalSignature: SIGNATURE, behaviorStatus: "effect_confirmed", exhaustive: true, vectorsRun: 32,
    });
    expect(view.planHash).toBe("sha256:plan");
    expect(view.independentlyReproduced).toBe(true);
    expect(view.vectorBudget).toMatchObject({ used: 32, exhausted: false });
    expect(view.skipped).toHaveLength(1);
    expect(view.gaps).toHaveLength(1);
    expect(view.scopeNotes.join(" ")).toContain("never that the function has the meaning its name suggests");
  });

  it("withholds the raw probe evidence, branch records and fork run ids", () => {
    const serialised = JSON.stringify(projectPublicView(record, artifact()));
    expect(serialised).not.toContain("run-a");
    expect(serialised).not.toContain("branches");
    expect(serialised).not.toContain("empty_revert");
  });

  it("redacts an address that leaked into a generated note, rather than trusting the wording", () => {
    const view = projectPublicView(record, artifact());
    if (view.status !== "publishable") throw new Error("expected publishable");
    expect(view.candidates[0]?.note).toContain("[redacted]");
    expect(JSON.stringify(view.candidates.map((c) => c.note))).not.toContain(CALLER);
  });

  it("publishes the reproduced view, so an unreproduced positive shows as inconclusive", () => {
    const unreproduced = artifact({
      reproduction: { independent: false, gaps: ["disagreed"], candidates: [outcome("inconclusive")] },
    });
    const view = projectPublicView(record, unreproduced);
    if (view.status !== "publishable") throw new Error("expected publishable");
    expect(view.candidates[0]?.behaviorStatus).toBe("inconclusive");
    expect(view.independentlyReproduced).toBe(false);
  });
});

describe("recoverOnBoot — a crash never publishes", () => {
  const pending: AiSidecarRecord = { reportId: "rep_1", status: "pending_private", reason: "r", updatedAt: "t", artifactLocation: null };

  it("resolves an interrupted run with no artifact to unavailable", () => {
    expect(recoverOnBoot(pending, null)).toMatchObject({ status: "unavailable", artifactLocation: null });
  });

  it("resolves an interrupted run whose artifact saw a restriction to review_required", () => {
    const recovered = recoverOnBoot(pending, artifact({ complete: false, completedAt: null, runs: [run("unattributed_caller_restriction_observed")] }));
    expect(recovered).toMatchObject({ status: "review_required", artifactLocation: "quarantine" });
  });

  it("never reaches publishable, whatever the artifact says", () => {
    for (const candidate of [null, artifact(), artifact({ complete: true })]) {
      expect(recoverOnBoot(pending, candidate).status).not.toBe("publishable");
    }
  });

  it("leaves an already-decided record alone", () => {
    const decided: AiSidecarRecord = { ...pending, status: "publishable" };
    expect(recoverOnBoot(decided, artifact())).toBe(decided);
  });
});

describe("AiSidecarStore", () => {
  let dir: string;
  let store: AiSidecarStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ripcord-ai-"));
    store = new AiSidecarStore(dir);
    await store.init();
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("writes a quarantined artifact to the quarantine directory and never to the private one", async () => {
    await store.markPending("rep_1");
    await store.completeRun("rep_1", artifact({ runs: [run("unattributed_caller_restriction_observed")] }));

    expect(await readdir(join(dir, "ai-selector-quarantine"))).toEqual(["rep_1.json"]);
    expect(await readdir(join(dir, "ai-selector-private"))).toEqual([]);
    expect(await store.loadPublicView("rep_1")).toEqual({ status: "review_required", message: AI_SIDECAR_REVIEW_MESSAGE });
  });

  it("keeps the status record free of any contract detail, so logs stay safe", async () => {
    await store.completeRun("rep_1", artifact({ runs: [run("unattributed_caller_restriction_observed")] }));
    const raw = await readFile(join(dir, "ai-selector", "rep_1.json"), "utf8");

    expect(raw).not.toContain(SELECTOR);
    expect(raw).not.toContain(CALLER);
    expect(raw).not.toMatch(/0x[0-9a-fA-F]{8}/);
    expect(JSON.parse(raw).reason).toBe("a fork observation requires manual review before publication");
  });

  it("serves a clean run through the public projection", async () => {
    await store.completeRun("rep_1", artifact());
    const view = await store.loadPublicView("rep_1");
    expect(view.status).toBe("publishable");
    expect(await readdir(join(dir, "ai-selector-private"))).toEqual(["rep_1.json"]);
  });

  it("reports an unknown report as not_requested rather than inventing a state", async () => {
    expect(await store.loadPublicView("rep_missing")).toEqual({ status: "not_requested" });
  });

  it("recovers an interrupted run to unavailable, and to quarantine when its artifact warrants it", async () => {
    await store.markPending("rep_clean");
    await store.markPending("rep_dirty");
    // Simulate a crash after the artifact landed but before the record was updated.
    const dirty = new AiSidecarStore(dir);
    await dirty.completeRun("rep_dirty", artifact({ runs: [run("unattributed_caller_restriction_observed")] }));
    await dirty.markPending("rep_dirty");

    const touched = await store.recoverInterrupted();
    expect(touched).toContainEqual({ reportId: "rep_clean", status: "unavailable" });
    expect(touched).toContainEqual({ reportId: "rep_dirty", status: "review_required" });
    expect((await store.loadPublicView("rep_dirty")).status).toBe("review_required");
  });

  it("refuses an id that could escape its directory", async () => {
    await expect(store.loadRecord("../escape")).rejects.toThrow(/unsafe identifier/);
  });

  it("treats a corrupted artifact as absent rather than parsing it partially", async () => {
    await store.completeRun("rep_1", artifact());
    const record = (await store.loadRecord("rep_1"))!;
    const { writeFile: write } = await import("node:fs/promises");
    await write(join(dir, "ai-selector-private", "rep_1.json"), JSON.stringify({ version: "wrong" }), "utf8");

    expect(await store.loadArtifact(record)).toBeNull();
    expect((await store.loadPublicView("rep_1")).status).toBe("unavailable");
  });
});

describe("parseArtifact", () => {
  it("accepts a well-formed artifact and rejects a truncated one", () => {
    expect(parseArtifact(JSON.parse(JSON.stringify(artifact())))).not.toBeNull();
    const { runs, ...missingRuns } = artifact();
    expect(parseArtifact(missingRuns)).toBeNull();
    expect(parseArtifact({ version: "ai-selector-artifact/v2" })).toBeNull();
  });
});
