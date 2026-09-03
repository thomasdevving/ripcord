/**
 * THE OBSERVER MUST NOT CHANGE THE REPORT.
 *
 * This is the load-bearing property of the whole webapp integration. Ripcord's
 * central claim is that a report is a deterministic, block-pinned artifact:
 * same target, same block, byte-identical output. Adding progress hooks to the
 * engine put that claim at risk in a way no amount of care in the hook bodies
 * would settle — so it is tested directly, at the only level that matters:
 * build the same report twice, once with an observer attached and once without,
 * and compare the serialised bytes.
 *
 * The second test is the other half: a hook that THROWS must be contained. A
 * broken SSE consumer, or a browser closing its tab mid-scan, must not be able
 * to alter what a report says about a contract. Rule 3 of this project forbids
 * silent catches, and this one is neither silent (it warns on stderr) nor a
 * swallowed chain failure — it contains a presentation fault so it cannot
 * corrupt an analysis.
 */
import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { buildReport } from "../src/report/build.js";
import { notify, notifyFork, type RunObserver, type ForkObserver } from "../src/report/observer.js";
import type { ChainReader, Evidence } from "../src/chain/client.js";

const TARGET = "0x00000000000000000000000000000000000000aa" as Hex;

function ev(): Evidence {
  return { kind: "call", params: {}, rawValue: "0x", block: "100" };
}

/**
 * A network-free ChainReader that answers everything with an empty/reverted
 * result. Enough to drive buildReport end to end deterministically; the point
 * here is the OBSERVER's effect on the output, not the detectors' findings.
 */
function fakeChain(): ChainReader {
  return {
    chainId: 1,
    blockNumber: 100n,
    getBlockHash: async () => "0xabc" as Hex,
    getCodeAtBlock: async () => ({ code: "0x6080" as Hex }),
    getCode: async () => ({ code: "0x6080" as Hex, evidence: ev() }),
    getStorageAt: async () => ({ value: `0x${"0".repeat(64)}` as Hex, evidence: ev() }),
    call: async () => ({ result: undefined, reverted: true, evidence: ev() }),
    probeCall: async () => ({ revertData: undefined, reverted: true, evidence: ev() }),
    getLogs: async () => ({ logs: [], evidence: ev() }),
  };
}

/** Strips the one field that is legitimately wall-clock — everything else must match byte for byte. */
function stable(json: string): string {
  return json.replace(/"generatedAt":\s*"[^"]*"/, '"generatedAt":"<pinned>"');
}

describe("engine observer", () => {
  it("produces a byte-identical report whether or not an observer is attached", async () => {
    const withoutObserver = await buildReport(fakeChain(), TARGET);

    const seen: string[] = [];
    const observer: RunObserver = {
      onStageStart: (stage) => seen.push(`start:${stage}`),
      onStageEnd: (end) => seen.push(`end:${end.stage}:${end.outcome}`),
      onProxy: () => seen.push("proxy"),
      onOwnership: () => seen.push("ownership"),
      onAccessControl: () => seen.push("accessControl"),
      onCapabilities: () => seen.push("capabilities"),
      onPowerHolders: () => seen.push("powerHolders"),
      onAuthority: () => seen.push("authority"),
      onAuthorityIndirection: () => seen.push("indirection"),
      onExitWindow: () => seen.push("exitWindow"),
      onTimeToExit: () => seen.push("timeToExit"),
      onVerdict: () => seen.push("verdict"),
    };
    const withObserver = await buildReport(fakeChain(), TARGET, observer);

    expect(stable(JSON.stringify(withObserver))).toBe(stable(JSON.stringify(withoutObserver)));
    // And it genuinely ran — a vacuously-passing test here would be worse than none.
    expect(seen).toContain("proxy");
    expect(seen).toContain("verdict");
    expect(seen.some((s) => s.startsWith("start:"))).toBe(true);
  });

  it("reports stages in the engine's real order, never a rearranged one", async () => {
    const starts: string[] = [];
    await buildReport(fakeChain(), TARGET, { onStageStart: (stage) => starts.push(stage) });

    // The exit window CONSUMES the authority resolution and the capability
    // guards, so it can never precede them. A UI that reordered these would be
    // describing an analysis that did not happen.
    expect(starts.indexOf("authorityResolution")).toBeLessThan(starts.indexOf("exitWindow"));
    expect(starts.indexOf("capabilities")).toBeLessThan(starts.indexOf("exitWindow"));
    expect(starts.indexOf("proxy")).toBeLessThan(starts.indexOf("capabilities"));
  });

  it("contains a throwing hook without changing the report", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const clean = await buildReport(fakeChain(), TARGET);

    const hostile: RunObserver = {
      onStageStart: () => {
        throw new Error("the SSE consumer exploded");
      },
      onProxy: () => {
        throw new Error("and again");
      },
    };
    const survived = await buildReport(fakeChain(), TARGET, hostile);

    expect(stable(JSON.stringify(survived))).toBe(stable(JSON.stringify(clean)));
    // Contained, but NOT silent: it must be visible in the log.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("contains a throwing fork hook too", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hostile: ForkObserver = {
      onForkStep: () => {
        throw new Error("boom");
      },
    };
    expect(() => notifyFork(hostile, "onForkStep", { phase: "baseline", outcome: "completed", detail: "x" })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is a no-op when no observer is supplied", () => {
    expect(() => notify(undefined, "onStageStart", "proxy")).not.toThrow();
    expect(() => notifyFork(undefined, "onForkStart", "baseline")).not.toThrow();
  });

  it("marks a stage that threw as degraded, never completed", async () => {
    const ends: { stage: string; outcome: string }[] = [];
    const chain = fakeChain();
    // A stage that fails infrastructurally must reach the observer as
    // `degraded`. If it arrived as `completed`, a UI would paint a green tick
    // over a fallback value — the exact false-clean this project refuses.
    const failing: ChainReader = {
      ...chain,
      getStorageAt: async () => {
        throw new Error("provider exploded");
      },
    };
    await buildReport(failing, TARGET, { onStageEnd: (end) => ends.push({ stage: end.stage, outcome: end.outcome }) });

    const proxyStage = ends.find((e) => e.stage === "proxy");
    expect(proxyStage?.outcome).toBe("degraded");
    expect(ends.every((e) => e.outcome !== "completed" || e.stage !== "proxy")).toBe(true);
  });
});
