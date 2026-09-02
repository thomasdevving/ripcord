/**
 * The enumeration witness is FAIL-CLOSED, and these tests are mostly about that
 * one property rather than about coverage.
 *
 * The witness exists to stop a reassuring verdict resting on an authority
 * picture that was never fully seen. If its own derivation read an absent or
 * malformed completeness flag as "complete", it would launder a failed read into
 * a fact — the exact bug class it closes, reintroduced inside the fix, in the
 * one place nobody would look for it again. So the cases below are deliberately
 * weighted toward the shapes that are NOT a clean `complete: true`.
 */
import { describe, expect, it } from "vitest";
import { deriveEnumerationCompleteness, witnessOf } from "../src/report/enumeration.js";
import type {
  AccessControlResult,
  AuthorityNode,
  AuthorityResolution,
  CapabilitiesResult,
  DependencyGraph,
  OwnerField,
  ProxyResult,
  RoleReconstruction,
} from "../src/report/schema.js";

const complete = (): RoleReconstruction => ({
  complete: true,
  confidence: "high",
  note: "full scan",
  maxLogRange: null,
  scannedFromBlock: "1",
  scannedToBlock: "2",
});
const partial = (): RoleReconstruction => ({
  complete: false,
  confidence: "low",
  note: "partial event-reconstruction: covered only a recent window",
  maxLogRange: "9",
  scannedFromBlock: "100",
  scannedToBlock: "109",
});

const ac = (over: Partial<AccessControlResult> = {}): AccessControlResult => ({
  detected: false,
  method: "not_applicable",
  roles: [],
  reconstruction: null,
  ...over,
});

const node = (over: Partial<AuthorityNode> = {}): AuthorityNode => ({
  address: "0x00000000000000000000000000000000000000aa",
  relation: "owner",
  depth: 1,
  confidence: "high",
  type: "contract",
  safe: null,
  timelock: null,
  terminal: true,
  terminationReason: "no_authority_found",
  accessControlDetected: false,
  roleEnumeration: null,
  children: [],
  evidence: [],
  ...over,
});

const res = (roots: AuthorityNode[]): AuthorityResolution => ({
  maxDepth: 3,
  roots,
  paths: [],
  cyclesDetected: [],
});

const noDeps = (): DependencyGraph => ({ tokens: [], oracles: [] });

/** A capability surface that was FULLY evaluated: dispatcher decoded, nothing unmatched. */
const evaluatedSurface = (over: Partial<CapabilitiesResult> = {}): CapabilitiesResult => ({
  taxonomyVersion: "test",
  dispatcherRecognized: true,
  scannedAddress: "0x00000000000000000000000000000000000000aa",
  probedAddress: "0x00000000000000000000000000000000000000aa",
  selectorsExtracted: 3,
  unmatchedSelectors: [],
  findings: [],
  needsManualVerification: [],
  evidence: [],
  ...over,
});

const noOwner = (): OwnerField => ({ address: null, source: "owner() reverted", evidence: [] });
const someOwner = (): OwnerField => ({
  address: "0x00000000000000000000000000000000000000bb",
  source: "owner()",
  evidence: [],
});
const noProxy = (): ProxyResult =>
  ({ pattern: "not_a_proxy", isProxy: false, implementation: null, beacon: null, admin: null, evidence: [] }) as ProxyResult;

const derive = (over: Parameters<typeof deriveEnumerationCompleteness>[0] | Record<string, never> = {}) =>
  deriveEnumerationCompleteness({
    accessControl: ac(),
    authorityResolution: res([]),
    dependencies: noDeps(),
    errors: [],
    // Default to a surface that was fully evaluated with nobody privileged over
    // it, so these cases isolate the property each one is actually about.
    capabilities: evaluatedSurface(),
    owner: noOwner(),
    pendingOwner: noOwner(),
    proxy: noProxy(),
    indirection: null,
    ...over,
  } as Parameters<typeof deriveEnumerationCompleteness>[0]);

describe("enumeration witness — the complete case", () => {
  it("is complete when nothing anywhere is an AccessControl contract", () => {
    const e = derive();
    expect(e.complete).toBe(true);
    expect(e.gaps).toEqual([]);
    expect(witnessOf(e)).toEqual({ complete: true, basis: e.note });
  });

  it("is complete when every scan that ran positively reported completeness", () => {
    const e = derive({
      accessControl: ac({ detected: true, reconstruction: complete() }),
      authorityResolution: res([node({ accessControlDetected: true, roleEnumeration: complete() })]),
      dependencies: noDeps(),
      errors: [],
    });
    expect(e.complete).toBe(true);
  });
});

describe("enumeration witness — FAIL-CLOSED on every non-answer", () => {
  it("a partial scan on the TARGET is incomplete", () => {
    const e = derive({
      accessControl: ac({ detected: true, reconstruction: partial() }),
      authorityResolution: res([]),
      dependencies: noDeps(),
      errors: [],
    });
    expect(e.complete).toBe(false);
    expect(witnessOf(e)).toBeNull();
    expect(e.gaps[0]!.where).toBe("target");
  });

  it("a partial scan on an authority node AT ANY DEPTH is incomplete, even when the target is not AccessControl at all", () => {
    // The live Ethena USDe shape, and the reason this witness is an aggregate
    // rather than a flag on the target: a target-only check calls this complete.
    const e = derive({
      accessControl: ac({ detected: false }),
      authorityResolution: res([
        node({
          children: [node({ depth: 2, accessControlDetected: true, roleEnumeration: partial() })],
        }),
      ]),
      dependencies: noDeps(),
      errors: [],
    });
    expect(e.complete).toBe(false);
    expect(e.gaps[0]!.where).toContain("depth 2");
  });

  it("AccessControl detected with NO reconstruction is incomplete — the role set is unknown, not empty", () => {
    // accessControl.ts returns this when the deployment block could not be
    // found, so the event scan never ran. `roles: []` here means "we do not
    // know", and reading it as "there are none" is the whole failure.
    const e = derive({
      accessControl: ac({ detected: true, reconstruction: null }),
      authorityResolution: res([]),
      dependencies: noDeps(),
      errors: [],
    });
    expect(e.complete).toBe(false);
    expect(e.gaps[0]!.reason).toContain("entirely unknown, not empty");
  });

  it("a MISSING access-control result is incomplete, never assumed clean", () => {
    const e = derive({ accessControl: null, authorityResolution: res([]), dependencies: noDeps(), errors: [] });
    expect(e.complete).toBe(false);
  });

  it("an UNDEFINED completeness flag is incomplete — strict === true, never !== false", () => {
    // A shape that should not occur, handled the safe way regardless: this is
    // the assertion that stops a future refactor quietly re-opening the class.
    const malformed = { ...complete(), complete: undefined as unknown as boolean };
    const e = derive({
      accessControl: ac({ detected: true, reconstruction: malformed }),
      authorityResolution: res([]),
      dependencies: noDeps(),
      errors: [],
    });
    expect(e.complete).toBe(false);
  });

  it("a FAILED stage is incomplete — its fallback value cannot establish anything", () => {
    // runStage replaces a thrown stage with a safe empty result whose shape is
    // indistinguishable from a genuine "nothing found", so the failure is read
    // from errors[] rather than from the fabricated value.
    for (const stage of ["accessControl", "authorityResolution", "dependencies"]) {
      const e = derive({
        accessControl: ac(),
        authorityResolution: res([]),
        dependencies: noDeps(),
        errors: [{ stage, message: "boom" }],
      });
      expect(e.complete, stage).toBe(false);
      expect(e.gaps[0]!.where).toBe(`stage:${stage}`);
    }
  });

  it("a null authorityResolution or dependency graph is incomplete", () => {
    expect(derive({ accessControl: ac(), authorityResolution: null, dependencies: noDeps(), errors: [] }).complete).toBe(false);
    expect(derive({ accessControl: ac(), authorityResolution: res([]), dependencies: null, errors: [] }).complete).toBe(false);
  });

  it("a partial scan on a DEPENDENCY token is incomplete", () => {
    const deps = {
      tokens: [
        {
          token: "0x00000000000000000000000000000000000000dd",
          authority: { owner: null, pendingOwner: null, accessControl: ac({ detected: true, reconstruction: partial() }) },
        },
      ],
      oracles: [],
    } as unknown as DependencyGraph;
    const e = derive({ accessControl: ac(), authorityResolution: res([]), dependencies: deps, errors: [] });
    expect(e.complete).toBe(false);
    expect(e.gaps[0]!.where).toContain("dependency:");
  });

  it("collects EVERY gap rather than stopping at the first", () => {
    const e = derive({
      accessControl: ac({ detected: true, reconstruction: partial() }),
      authorityResolution: res([node({ accessControlDetected: true, roleEnumeration: partial() })]),
      dependencies: noDeps(),
      errors: [{ stage: "dependencies", message: "boom" }],
    });
    expect(e.gaps).toHaveLength(3);
    expect(e.complete).toBe(false);
  });

  it("gaps is empty if and only if complete", () => {
    for (const e of [
      derive(),
      derive({ accessControl: ac({ detected: true, reconstruction: partial() }), authorityResolution: res([]), dependencies: noDeps(), errors: [] }),
    ]) {
      expect(e.gaps.length === 0).toBe(e.complete);
    }
  });
});

/**
 * The capability-surface dimension, added after Compound III passed every ROLE
 * check and was still wrong: fully-resolved implementation, decoded dispatcher,
 * clean reconstruction — and a guarded `pause(bool,bool,bool,bool,bool)` sitting
 * unevaluated among 67 unmatched selectors, callable by a guardian who can shut
 * withdrawals with no notice. The verdict read "You can exit before the rules
 * CAN change."
 *
 * These tests pin the DISCRIMINATOR, because the naive rule is wrong in a way
 * that is easy to ship: every one of the 26 calibration reports has unmatched
 * selectors, so "any unmatched selector withholds the witness" would delete
 * every reassuring verdict in the set — including WETH9's, which was earned by
 * deriving all 11 of its selectors and confirming none is privileged. What makes
 * an unevaluated selector dangerous is that somebody holds privilege here.
 */
describe("enumeration witness — the capability SURFACE, not just the role set", () => {
  const unevaluated = () => evaluatedSurface({ selectorsExtracted: 67, unmatchedSelectors: ["0x44c35d07", "0xdeadbeef"] });

  it("withholds the witness when a privileged party exists AND selectors were never evaluated", () => {
    // The Comet shape.
    const e = derive({ capabilities: unevaluated(), owner: someOwner() } as never);
    expect(e.complete).toBe(false);
    expect(witnessOf(e)).toBeNull();
    expect(e.gaps.some((g) => g.site.kind === "capabilitySurface")).toBe(true);
    expect(e.gaps.find((g) => g.site.kind === "capabilitySurface")!.reason).toMatch(/never evaluated for privilege/);
  });

  it("KEEPS the witness when nobody is privileged, however many selectors are unevaluated", () => {
    // The WETH9 shape, and the reason the rule is not "any unmatched selector".
    // With no owner, no pendingOwner, no proxy admin, no role members and no
    // indirection, there is nobody for an unevaluated selector to be privileged
    // FOR — so it is inert, and a hard-earned true negative survives.
    const e = derive({ capabilities: unevaluated() } as never);
    expect(e.complete).toBe(true);
    expect(witnessOf(e)).not.toBeNull();
  });

  it.each([
    ["a proxy admin", { proxy: { pattern: "eip1967_transparent", isProxy: true, implementation: "0x00000000000000000000000000000000000000cc", beacon: null, admin: "0x00000000000000000000000000000000000000dd", evidence: [] } }],
    ["a role with members", { accessControl: ac({ detected: true, reconstruction: complete(), roles: [{ role: "0x00", name: "ADMIN", members: ["0x00000000000000000000000000000000000000ee"], adminRole: null, evidence: [] }] }) }],
    ["an authority-indirection marker", { indirection: { version: "t", gettersProbed: ["governor()"], markers: [{ signature: "governor()", selector: "0x0c340a24", target: "0x00000000000000000000000000000000000000ff", evidence: { kind: "call", params: {}, rawValue: "0x", block: "1" } }] } }],
  ])("counts %s as a privileged party", (_label, over) => {
    const e = derive({ capabilities: unevaluated(), ...over } as never);
    expect(e.complete).toBe(false);
    expect(e.gaps.some((g) => g.site.kind === "capabilitySurface")).toBe(true);
  });

  it("treats an UNDECODED dispatcher as unevaluated, not as 'no selectors'", () => {
    // Zero unmatched selectors because zero were recovered is the worst case,
    // not the best one. `!== true` throughout, never `!== false`.
    const e = derive({
      capabilities: evaluatedSurface({ dispatcherRecognized: false, selectorsExtracted: 0, unmatchedSelectors: [] }),
      owner: someOwner(),
    } as never);
    expect(e.complete).toBe(false);
    expect(e.gaps.find((g) => g.site.kind === "capabilitySurface")!.reason).toMatch(/dispatcher could not be decoded/);
  });

  it("is complete when the surface was fully evaluated even with a privileged party", () => {
    // The rule must not fire on a contract whose every selector IS classified —
    // otherwise it is a blanket veto rather than a discriminator.
    const e = derive({ capabilities: evaluatedSurface(), owner: someOwner() } as never);
    expect(e.complete).toBe(true);
  });

  it("fail-closes when there is no capability result at all", () => {
    const e = derive({ capabilities: null } as never);
    expect(e.complete).toBe(false);
    expect(e.gaps.find((g) => g.site.kind === "capabilitySurface")!.reason).toMatch(/no capability result is present/);
  });
});
