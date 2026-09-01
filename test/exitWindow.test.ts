/**
 * Exit-window unit tests. Network-free: every chain read is served by a fake
 * ChainReader, so these run in CI alongside the rest.
 *
 * The revert strings asserted here are the EXACT bytes read from mainnet
 * before exitWindow.ts was written (Compound Timelock 0x6d903f60… and the ENS
 * DAO TimelockController 0xfe89cc7a… at block 25800000, via eth_call from an
 * unrelated sender). They are the evidence behind `proven_binding`, which is
 * the one determination in this project that must never be reached
 * optimistically — so it gets tested against real bytes rather than against a
 * string this file made up.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, toBytes, toFunctionSelector, type Hex } from "viem";
import {
  TIMELOCK_UNAUTHORIZED_CALLER_SELECTOR,
  analyseTimelockBinding,
  classifyDelayGuardRevert,
  exitWindowRulesVersion,
  analyseExitWindow,
} from "../src/detect/exitWindow.js";
import { ERROR_STRING_SELECTOR } from "../src/detect/guardProbe.js";
import type { ChainReader, Evidence } from "../src/chain/client.js";
import type {
  AuthorityNode,
  AuthorityResolution,
  CapabilitiesResult,
  ProxyResult,
  RoleEntry,
  TimelockInfo,
} from "../src/report/schema.js";

const ZERO_ROLE = `0x${"0".repeat(64)}`;
const MINTER_ROLE = keccak256(toBytes("MINTER_ROLE"));
const MARKER_ROLE = keccak256(toBytes("FULL_RESTRICTED_STAKER_ROLE"));

const role = (hash: string, name: string | null, adminRole: string | null = ZERO_ROLE): RoleEntry => ({
  role: hash,
  name,
  members: [],
  adminRole,
  evidence: [],
});

/** Encodes a Solidity `Error(string)` revert payload exactly as a node returns it. */
function errorString(message: string): Hex {
  return (ERROR_STRING_SELECTOR + encodeAbiParameters([{ type: "string" }], [message]).slice(2)) as Hex;
}

const ev = (): Evidence => ({ kind: "call", params: {}, rawValue: "0x", block: "1" });

interface FakeOptions {
  code?: Record<string, Hex>;
  calls?: Record<string, Hex>;
  probes?: Record<string, Hex>;
  storage?: Record<string, Hex>;
}

/** Minimal ChainReader for these tests. Anything not configured reverts, which is the honest default. */
function fakeChain(opts: FakeOptions): ChainReader {
  const key = (a: string, b: string) => `${a.toLowerCase()}:${b.toLowerCase()}`;
  return {
    chainId: 1,
    blockNumber: 1n,
    async getBlockHash() {
      return "0x00" as Hex;
    },
    async getCodeAtBlock() {
      return { code: undefined };
    },
    async getCode(address) {
      return { code: opts.code?.[address.toLowerCase()], evidence: ev() };
    },
    async getStorageAt(address, slot) {
      return { value: opts.storage?.[key(address, slot)] ?? (`0x${"0".repeat(64)}` as Hex), evidence: ev() };
    },
    async call(address, data) {
      const hit = opts.calls?.[key(address, data.slice(0, 10))];
      return { result: hit, reverted: hit === undefined, evidence: ev() };
    },
    async probeCall(address, data) {
      const hit = opts.probes?.[key(address, data.slice(0, 10))];
      return { revertData: hit, reverted: true, evidence: ev() };
    },
    async getLogs() {
      return { logs: [], evidence: ev() };
    },
  };
}

/**
 * A minimal contract whose dispatcher exposes exactly the given selectors.
 * Built with the same shape dispatcher.ts recognises: load the selector with
 * CALLDATALOAD/SHR, then one `DUP1 PUSH4 <sel> EQ PUSH1 <dest> JUMPI` per
 * function, each landing on a real JUMPDEST.
 */
function dispatcherBytecode(selectors: Hex[]): Hex {
  // PUSH1 0x00 CALLDATALOAD PUSH1 0xe0 SHR  → selector on the stack
  let code = "60003560e01c";
  // Each comparison is 12 bytes: DUP1(1) PUSH4+4(5) EQ(1) PUSH2+2(3) JUMPI(1)
  const headerLen = 6;
  const cmpLen = 12;
  const bodyStart = headerLen + selectors.length * cmpLen + 1; // +1 for the trailing STOP
  selectors.forEach((sel, i) => {
    const dest = bodyStart + i;
    code += "80" + "63" + sel.slice(2) + "14" + "61" + dest.toString(16).padStart(4, "0") + "57";
  });
  code += "00"; // STOP: end of the dispatch block
  code += "5b00".repeat(selectors.length).replace(/5b00/g, "5b"); // one JUMPDEST per function body
  return ("0x" + code) as Hex;
}

const UPDATE_DELAY = toFunctionSelector("updateDelay(uint256)");
const SET_DELAY = toFunctionSelector("setDelay(uint256)");

const timelockInfo = (delaySeconds: string | null, kind: TimelockInfo["kind"] = "openzeppelin"): TimelockInfo => ({
  kind,
  delaySeconds,
  cancellers: null,
  executors: null,
  adminCanShortenDelay: null,
  note: "test",
  evidence: [],
});

describe("delay-guard revert classification", () => {
  it("derives the OZ v5 custom error selector rather than hardcoding it", () => {
    expect(TIMELOCK_UNAUTHORIZED_CALLER_SELECTOR).toBe(
      keccak256(toBytes("TimelockUnauthorizedCaller(address)")).slice(0, 10),
    );
  });

  it("recognises the OZ v4 TimelockController self-call gate (exact mainnet string)", () => {
    expect(classifyDelayGuardRevert(errorString("TimelockController: caller must be timelock"))).toBe("self_call");
  });

  it("recognises the Compound Timelock self-call gate (exact mainnet string)", () => {
    expect(classifyDelayGuardRevert(errorString("Timelock::setDelay: Call must come from Timelock."))).toBe("self_call");
  });

  it("allows a fork's renamed contract prefix but not a changed phrase", () => {
    expect(classifyDelayGuardRevert(errorString("MyTimelock::setDelay: Call must come from Timelock."))).toBe("self_call");
    expect(classifyDelayGuardRevert(errorString("Timelock::setDelay: only the timelock may call this"))).toBe(
      "unrecognized",
    );
  });

  it("recognises the OZ v5 custom self-call error", () => {
    const payload = (TIMELOCK_UNAUTHORIZED_CALLER_SELECTOR +
      encodeAbiParameters([{ type: "address" }], ["0x0000000000000000000000000000000000000001"]).slice(2)) as Hex;
    expect(classifyDelayGuardRevert(payload)).toBe("self_call");
  });

  it("classifies an Ownable/AccessControl gate as a ROLE gate, never as self-call", () => {
    expect(classifyDelayGuardRevert(errorString("Ownable: caller is not the owner"))).toBe("role");
    expect(
      classifyDelayGuardRevert(
        errorString(
          "AccessControl: account 0x0000000000000000000000000000000000000001 is missing role 0x0000000000000000000000000000000000000000000000000000000000000000",
        ),
      ),
    ).toBe("role");
  });

  it("treats anything unrecognised — including no revert data — as unrecognised, never as binding", () => {
    expect(classifyDelayGuardRevert(undefined)).toBe("unrecognized");
    expect(classifyDelayGuardRevert("0x" as Hex)).toBe("unrecognized");
    expect(classifyDelayGuardRevert(errorString("insufficient balance"))).toBe("unrecognized");
    expect(classifyDelayGuardRevert("0xdeadbeef" as Hex)).toBe("unrecognized");
  });
});

describe("timelock binding analysis", () => {
  const TL = "0x000000000000000000000000000000000000ab01" as Hex;

  it("proves binding when the delay mutator is self-call gated", async () => {
    const chain = fakeChain({
      code: { [TL]: dispatcherBytecode([UPDATE_DELAY]) },
      probes: {
        [`${TL}:${UPDATE_DELAY.toLowerCase()}`]: errorString("TimelockController: caller must be timelock"),
      },
    });
    const result = await analyseTimelockBinding(chain, TL, timelockInfo("172800"));
    expect(result.binding).toBe("proven_binding");
    expect(result.method).toBe("self_call_gated_revert");
  });

  it("reports SHORTENABLE when the delay mutator is role gated — the dangerous case", async () => {
    const chain = fakeChain({
      code: { [TL]: dispatcherBytecode([UPDATE_DELAY]) },
      probes: { [`${TL}:${UPDATE_DELAY.toLowerCase()}`]: errorString("Ownable: caller is not the owner") },
    });
    const result = await analyseTimelockBinding(chain, TL, timelockInfo("172800"));
    expect(result.binding).toBe("shortenable");
    expect(result.method).toBe("role_gated_revert");
  });

  it("proves binding when no delay mutator exists at all", async () => {
    const chain = fakeChain({ code: { [TL]: dispatcherBytecode([toFunctionSelector("getMinDelay()")]) } });
    const result = await analyseTimelockBinding(chain, TL, timelockInfo("172800"));
    expect(result.binding).toBe("proven_binding");
    expect(result.method).toBe("no_mutator_present");
  });

  it("does NOT credit a delay as binding when the probe returns nothing interpretable", async () => {
    const chain = fakeChain({ code: { [TL]: dispatcherBytecode([SET_DELAY]) } }); // probes revert with no data
    const result = await analyseTimelockBinding(chain, TL, timelockInfo("172800", "compound_bravo"));
    expect(result.binding).toBe("cannot_determine");
    expect(result.method).toBe("probe_inconclusive");
  });

  it("does NOT credit a delay as binding when the dispatcher cannot be parsed", async () => {
    const chain = fakeChain({ code: { [TL]: "0x6001600155" as Hex } }); // no selector-load shape
    const result = await analyseTimelockBinding(chain, TL, timelockInfo("172800"));
    expect(result.binding).toBe("cannot_determine");
    expect(result.method).toBe("probe_inconclusive");
  });

  it("reports an unreadable delay as cannot_determine, not as an absent constraint", async () => {
    const chain = fakeChain({ code: { [TL]: dispatcherBytecode([UPDATE_DELAY]) } });
    const result = await analyseTimelockBinding(chain, TL, timelockInfo(null, "unknown"));
    expect(result.binding).toBe("cannot_determine");
    expect(result.method).toBe("delay_unreadable");
  });
});

// --- route composition ---

const EMPTY_PROXY: ProxyResult = {
  pattern: "not_a_proxy",
  isProxy: false,
  implementation: null,
  beacon: null,
  admin: null,
  slots: {},
  evidence: [],
};

const EMPTY_CAPS: CapabilitiesResult = {
  taxonomyVersion: "test",
  dispatcherRecognized: true,
  scannedAddress: null,
  probedAddress: "0x0000000000000000000000000000000000000001",
  selectorsExtracted: 0,
  unmatchedSelectors: [],
  findings: [],
  needsManualVerification: [],
  evidence: [],
};

function leaf(address: string, relation: string, type: AuthorityNode["type"], extra: Partial<AuthorityNode> = {}): AuthorityNode {
  return {
    address,
    relation,
    depth: 1,
    confidence: "high",
    type,
    safe: null,
    timelock: null,
    terminal: true,
    terminationReason: type === "eoa" ? "eoa" : type === "safe" ? "safe" : type === "timelock" ? "timelock" : "no_authority_found",
    children: [],
    evidence: [],
    ...extra,
  };
}

function resolution(roots: AuthorityNode[]): AuthorityResolution {
  return {
    maxDepth: 3,
    roots,
    paths: roots.map((r) => ({
      label: r.relation,
      hops: [{ address: r.address, relation: r.relation, type: r.type, depth: r.depth }],
      effectiveController: r.type === "contract" ? null : r.address,
      effectiveControllerType: r.type === "contract" ? null : r.type,
      terminationReason: r.terminationReason,
      confidence: r.confidence,
    })),
    cyclesDetected: [],
  };
}

const EOA = "0x00000000000000000000000000000000000000e0";
const SAFE = "0x00000000000000000000000000000000000000fe";

describe("exit-window composition", () => {
  it("treats a Safe as ZERO notice — a threshold is not a delay", async () => {
    const chain = fakeChain({});
    const { result } = await analyseExitWindow(chain, {
      proxy: EMPTY_PROXY,
      capabilities: EMPTY_CAPS,
      accessControlRoles: [],
      authorityResolution: resolution([
        leaf(SAFE, "owner", "safe", { safe: { threshold: 3, owners: [EOA, EOA, EOA], version: "1.3.0" } }),
      ]),
    });
    expect(result.assessment.status).toBe("no_notice");
    expect(result.routes[0]!.noticeSeconds).toBe("0");
    expect(result.bypasses.map((b) => b.kind)).toContain("ungated_route");
  });

  it("takes the MINIMUM across routes: one ungated route defeats a good timelock", async () => {
    const TL = "0x000000000000000000000000000000000000ab01" as Hex;
    const chain = fakeChain({
      code: { [TL]: dispatcherBytecode([UPDATE_DELAY]) },
      probes: { [`${TL}:${UPDATE_DELAY.toLowerCase()}`]: errorString("TimelockController: caller must be timelock") },
    });
    const { result } = await analyseExitWindow(chain, {
      proxy: EMPTY_PROXY,
      capabilities: {
        ...EMPTY_CAPS,
        findings: [
          {
            selector: "0x40c10f19",
            signature: "mint(address,uint256)",
            category: "SUPPLY",
            nameMatchSpecificity: "standard",
            scannedAddress: EOA,
            probedAddress: EOA,
            guard: { status: "attributed", holders: [EOA], authSource: "accessControlRole", role: MINTER_ROLE, evidence: [] },
          },
        ],
      },
      // MINTER_ROLE is credited as privileged here because a capability probe
      // attributed a guard to it — the same evidence the real path requires.
      accessControlRoles: [role(MINTER_ROLE, "MINTER_ROLE")],
      authorityResolution: resolution([
        leaf(TL, "proxyAdmin", "timelock", { timelock: timelockInfo("172800") }),
        leaf(EOA, "accessControl:MINTER_ROLE", "eoa"),
      ]),
    });
    expect(result.assessment.status).toBe("no_notice");
    // The good timelock is still reported as such — the minimum is the verdict,
    // not an erasure of the other route.
    expect(result.routes.find((r) => r.label === "proxyAdmin")!.noticeSeconds).toBe("172800");
  });

  it("reports a proven-binding delay as a real window", async () => {
    const TL = "0x000000000000000000000000000000000000ab01" as Hex;
    const chain = fakeChain({
      code: { [TL]: dispatcherBytecode([UPDATE_DELAY]) },
      probes: { [`${TL}:${UPDATE_DELAY.toLowerCase()}`]: errorString("TimelockController: caller must be timelock") },
    });
    const { result } = await analyseExitWindow(chain, {
      proxy: EMPTY_PROXY,
      capabilities: EMPTY_CAPS,
      accessControlRoles: [],
      authorityResolution: resolution([leaf(TL, "proxyAdmin", "timelock", { timelock: timelockInfo("172800") })]),
    });
    expect(result.assessment.status).toBe("binding");
    if (result.assessment.status === "binding") expect(result.assessment.windowSeconds).toBe("172800");
    expect(result.bypasses).toEqual([]);
  });

  it("NEVER reports an unproven delay as a window — it goes to nominalDelaySeconds", async () => {
    const TL = "0x000000000000000000000000000000000000ab01" as Hex;
    const chain = fakeChain({
      code: { [TL]: dispatcherBytecode([UPDATE_DELAY]) },
      probes: { [`${TL}:${UPDATE_DELAY.toLowerCase()}`]: errorString("Ownable: caller is not the owner") },
    });
    const { result } = await analyseExitWindow(chain, {
      proxy: EMPTY_PROXY,
      capabilities: EMPTY_CAPS,
      accessControlRoles: [],
      authorityResolution: resolution([leaf(TL, "proxyAdmin", "timelock", { timelock: timelockInfo("172800") })]),
    });
    expect(result.assessment.status).toBe("not_proven_binding");
    expect(JSON.stringify(result.assessment)).not.toContain("windowSeconds");
    if (result.assessment.status === "not_proven_binding") {
      expect(result.assessment.nominalDelaySeconds).toBe("172800");
    }
    expect(result.bypasses.map((b) => b.kind)).toContain("delay_shortenable");
  });

  it("excludes pendingOwner from the route set and records that it did", async () => {
    const chain = fakeChain({});
    const { result } = await analyseExitWindow(chain, {
      proxy: EMPTY_PROXY,
      capabilities: EMPTY_CAPS,
      accessControlRoles: [],
      authorityResolution: resolution([leaf(EOA, "pendingOwner", "eoa")]),
    });
    expect(result.routes).toEqual([]);
    const check = result.checksPerformed.find((c) => c.check === "pending_owner_excluded")!;
    expect(check.performed).toBe(true);
    expect(check.note).toContain("1 pendingOwner route(s) excluded");
  });

  it("distinguishes 'checked and found none' from 'not checked'", async () => {
    const chain = fakeChain({});
    const { result } = await analyseExitWindow(chain, {
      proxy: EMPTY_PROXY,
      capabilities: EMPTY_CAPS,
      accessControlRoles: [],
      authorityResolution: resolution([]),
    });
    expect(result.bypasses).toEqual([]);
    // An empty bypass list is only meaningful beside the record of what ran.
    expect(result.checksPerformed.length).toBeGreaterThan(0);
    expect(result.checksPerformed.some((c) => c.performed === false)).toBe(true);
    expect(result.checksPerformed.find((c) => c.check === "governance_proposal_path")!.note).toContain("NOT CHECKED");
  });

  it("a confirmed proxy with no resolvable authority is UNDETERMINED, never clean", async () => {
    const chain = fakeChain({});
    const { result } = await analyseExitWindow(chain, {
      proxy: { ...EMPTY_PROXY, pattern: "eip1967_uups", isProxy: true },
      capabilities: EMPTY_CAPS,
      accessControlRoles: [],
      authorityResolution: resolution([]),
    });
    expect(result.assessment.status).toBe("undetermined");
    if (result.assessment.status === "undetermined") expect(result.assessment.missing[0]).toContain("confirmed proxy");
  });

  it("reports no_rule_change_route_found with the unmatched-selector caveat attached", async () => {
    const chain = fakeChain({});
    const { result } = await analyseExitWindow(chain, {
      proxy: EMPTY_PROXY,
      capabilities: { ...EMPTY_CAPS, unmatchedSelectors: ["0xaabbccdd", "0x11223344"] },
      accessControlRoles: [],
      authorityResolution: resolution([]),
    });
    expect(result.assessment.status).toBe("no_rule_change_route_found");
    if (result.assessment.status === "no_rule_change_route_found") {
      expect(result.assessment.caveats.join(" ")).toContain("2 selector(s)");
      expect(result.assessment.caveats.join(" ")).toContain("not a proof of immutability");
    }
  });

  it("an unresolved contract authority is undetermined, and raises a bypass", async () => {
    const chain = fakeChain({});
    const { result } = await analyseExitWindow(chain, {
      proxy: EMPTY_PROXY,
      capabilities: EMPTY_CAPS,
      accessControlRoles: [],
      authorityResolution: resolution([leaf("0x00000000000000000000000000000000000000cc", "owner", "contract")]),
    });
    // No route carries a delay at all, so there is nothing to be "not proven
    // binding" about — that label would imply a delay the evidence never found.
    expect(result.assessment.status).toBe("undetermined");
    expect(result.bypasses.map((b) => b.kind)).toContain("unresolved_authority");
  });

  it("a zero-delay timelock imposes no notice and says so", async () => {
    const TL = "0x000000000000000000000000000000000000ab01" as Hex;
    const chain = fakeChain({ code: { [TL]: dispatcherBytecode([UPDATE_DELAY]) } });
    const { result } = await analyseExitWindow(chain, {
      proxy: EMPTY_PROXY,
      capabilities: EMPTY_CAPS,
      accessControlRoles: [],
      authorityResolution: resolution([leaf(TL, "proxyAdmin", "timelock", { timelock: timelockInfo("0") })]),
    });
    expect(result.assessment.status).toBe("no_notice");
    expect(result.bypasses.map((b) => b.kind)).toContain("zero_delay");
  });

  it("does NOT treat a MARKER role as an authority route — the sUSDe false positive", async () => {
    // Found live on Ethena's sUSDe: three plain EOAs hold
    // FULL_RESTRICTED_STAKER_ROLE. They are BLACKLISTED USERS, not admins, and
    // counting them made the window read "zero notice" on three addresses that
    // can change nothing. A role that is not DEFAULT_ADMIN_ROLE, administers no
    // other role, and has no capability attributed to it contributes nothing.
    const chain = fakeChain({});
    const { result } = await analyseExitWindow(chain, {
      proxy: EMPTY_PROXY,
      capabilities: EMPTY_CAPS,
      accessControlRoles: [role(MARKER_ROLE, null)],
      authorityResolution: resolution([leaf(EOA, `accessControl:${MARKER_ROLE}`, "eoa")]),
    });
    expect(result.routes[0]!.rolePrivilege).toBe("unverified");
    expect(result.routes[0]!.noticeStatus).toBe("undetermined");
    expect(result.assessment.status).toBe("undetermined");
    // Crucially it does NOT become a proven-zero window...
    expect(result.bypasses.map((b) => b.kind)).not.toContain("ungated_route");
  });

  it("an unverified role route can never let the window reach `binding` — the safety property", async () => {
    const TL = "0x000000000000000000000000000000000000ab01" as Hex;
    const chain = fakeChain({
      code: { [TL]: dispatcherBytecode([UPDATE_DELAY]) },
      probes: { [`${TL}:${UPDATE_DELAY.toLowerCase()}`]: errorString("TimelockController: caller must be timelock") },
    });
    const { result } = await analyseExitWindow(chain, {
      proxy: EMPTY_PROXY,
      capabilities: EMPTY_CAPS,
      accessControlRoles: [role(MARKER_ROLE, null)],
      authorityResolution: resolution([
        leaf(TL, "owner", "timelock", { timelock: timelockInfo("86400") }),
        leaf(EOA, `accessControl:${MARKER_ROLE}`, "eoa"),
      ]),
    });
    // The timelock really is proven binding...
    expect(result.routes.find((r) => r.label === "owner")!.timelock!.binding).toBe("proven_binding");
    // ...but one unverified route keeps the assessment out of `binding`.
    expect(result.assessment.status).toBe("not_proven_binding");
  });

  it("credits DEFAULT_ADMIN_ROLE as privileged by construction", async () => {
    const chain = fakeChain({});
    const { result } = await analyseExitWindow(chain, {
      proxy: EMPTY_PROXY,
      capabilities: EMPTY_CAPS,
      accessControlRoles: [role(ZERO_ROLE, "DEFAULT_ADMIN_ROLE")],
      authorityResolution: resolution([leaf(SAFE, "accessControl:DEFAULT_ADMIN_ROLE", "safe", { safe: { threshold: 3, owners: [EOA], version: null } })]),
    });
    expect(result.routes[0]!.rolePrivilege).toBe("verified");
    expect(result.assessment.status).toBe("no_notice");
  });

  it("credits a role that administers another role", async () => {
    const chain = fakeChain({});
    const GOV = keccak256(toBytes("GOVERNANCE_ROLE"));
    const { result } = await analyseExitWindow(chain, {
      proxy: EMPTY_PROXY,
      capabilities: EMPTY_CAPS,
      accessControlRoles: [role(GOV, "GOVERNANCE_ROLE"), role(MINTER_ROLE, "MINTER_ROLE", GOV)],
      authorityResolution: resolution([leaf(EOA, "accessControl:GOVERNANCE_ROLE", "eoa")]),
    });
    expect(result.routes[0]!.rolePrivilege).toBe("verified");
    expect(result.routes[0]!.rolePrivilegeNote).toContain("adminRole");
    expect(result.assessment.status).toBe("no_notice");
  });

  it("owner and proxyAdmin routes are never subject to the role-privilege gate", async () => {
    const chain = fakeChain({});
    const { result } = await analyseExitWindow(chain, {
      proxy: EMPTY_PROXY,
      capabilities: EMPTY_CAPS,
      accessControlRoles: [],
      authorityResolution: resolution([leaf(EOA, "owner", "eoa")]),
    });
    expect(result.routes[0]!.rolePrivilege).toBe("not_a_role");
    expect(result.assessment.status).toBe("no_notice");
  });

  it("pins the rules version so a change to the model is a visible change", () => {
    expect(exitWindowRulesVersion).toBe("0.1.0");
  });
});
