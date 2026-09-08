import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CapabilitiesResult, Report } from "../src/report/schema.js";
import {
  buildMobulaSecurityAudit,
  compareMobulaSecurity,
} from "../src/live/securityAudit.js";

beforeAll(() => { process.env.MOBULA_RETRY_BASE_MS = "0"; });
afterEach(() => vi.unstubAllGlobals());

function capabilities(
  signatures: { findings?: string[]; manual?: string[]; recognized?: boolean } = {},
): CapabilitiesResult {
  return {
    dispatcherRecognized: signatures.recognized ?? true,
    findings: (signatures.findings ?? []).map((signature) => ({ signature })),
    needsManualVerification: (signatures.manual ?? []).map((signature) => ({ signature })),
  } as CapabilitiesResult;
}

const target = "0x1111111111111111111111111111111111111111";
function report(caps: CapabilitiesResult = capabilities()): Pick<
  Report,
  "schemaVersion" | "rulesetVersion" | "chainId" | "block" | "target" | "capabilities"
> {
  return {
    schemaVersion: "0.15.0",
    rulesetVersion: "0.15.0",
    chainId: 1,
    block: { number: "123", hash: "0xabc" },
    target: { address: target, hasCode: true, bytecodeSize: 1, bytecodeHash: "0xabc" },
    capabilities: caps,
  };
}

function stubJson(body: unknown, status = 200, onUrl?: (url: string) => void): void {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    onUrl?.(String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      headers: new Map() as unknown as Headers,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
}

describe("Mobula token-security differential comparison", () => {
  it("compares only like-for-like signals and retains semantic caveats", () => {
    const comparisons = compareMobulaSecurity(
      capabilities({
        findings: ["mint(address,uint256)", "pause()"],
        manual: ["setWhitelist(address,bool)"],
      }),
      {
        isMintable: true,
        transferPausable: false,
        isBlacklisted: false,
        isWhitelisted: true,
      },
    );

    expect(comparisons.map(({ flag, outcome }) => [flag, outcome])).toEqual([
      ["minting", "both_observed"],
      ["transfer_pause", "ripcord_only"],
      ["blacklist", "both_not_observed"],
      ["whitelist", "both_observed"],
    ]);
    expect(comparisons.every((comparison) => comparison.note.length > 20)).toBe(true);
  });

  it("does not turn an unreadable dispatcher into four negative findings", () => {
    const comparisons = compareMobulaSecurity(
      capabilities({ recognized: false }),
      { isMintable: false, transferPausable: false, isBlacklisted: false, isWhitelisted: false },
    );
    expect(comparisons.every((comparison) => comparison.ripcordSignal === "dispatcher_unreadable")).toBe(true);
    expect(comparisons.every((comparison) => comparison.outcome === "not_comparable")).toBe(true);
  });

  it("keeps Mobula-only flags without inventing unsupported Ripcord comparisons", async () => {
    let requested = "";
    stubJson({
      data: {
        address: target,
        chainId: "evm:1",
        isMintable: true,
        transferPausable: false,
        isBlacklisted: null,
        isWhitelisted: false,
        balanceMutable: true,
        modifyableTax: true,
        selfDestruct: false,
        isHoneypot: false,
        staticAnalysisStatus: "completed",
        staticAnalysisDate: "2026-09-07T00:00:00.000Z",
      },
    }, 200, (url) => { requested = url; });

    const audit = await buildMobulaSecurityAudit(report(capabilities({ findings: ["mint(address,uint256)"] })));
    expect(requested).toContain("https://api.mobula.io/api/2/token/security?");
    expect(new URL(requested).searchParams.get("blockchain")).toBe("evm:1");
    expect(new URL(requested).searchParams.get("address")).toBe(target);
    expect(audit.status).toBe("ok");
    expect(audit.staticAnalysis).toEqual({ status: "completed", date: "2026-09-07T00:00:00.000Z" });
    expect(audit.otherMobulaSignals).toEqual({
      balanceMutable: true,
      modifiableTax: true,
      selfDestruct: false,
      honeypot: false,
    });
    expect(audit.summary).toEqual({ comparable: 3, agreements: 3, disagreements: 0, notComparable: 1 });
  });

  it("rejects a successful response for a different token instead of comparing it", async () => {
    stubJson({ data: { address: "0x2222222222222222222222222222222222222222", chainId: "evm:1" } });
    const audit = await buildMobulaSecurityAudit(report());
    expect(audit.status).toBe("unavailable");
    expect(audit.reason).toMatch(/identity did not match/);
    expect(audit.comparisons).toEqual([]);
  });
});
