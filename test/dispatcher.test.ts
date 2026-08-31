import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toFunctionSelector, type Hex } from "viem";
import { extractDispatcherSelectors } from "../src/detect/dispatcher.js";
import { Asm } from "./helpers/asm.js";

function loadFixture(name: string): Hex {
  return readFileSync(join(__dirname, "fixtures/bytecode", `${name}.hex`), "utf8").trim() as Hex;
}

/** Emits `DUP1 PUSH4 <selector> EQ PUSH2 <dest> JUMPI` — a linear-dispatch comparison. */
function eqBranch(asm: Asm, selector: number, destLabel: string): Asm {
  return asm.dup1().push4(selector).eq().push2Label(destLabel).jumpi();
}

/** Emits `DUP1 PUSH4 <pivot> GT PUSH2 <dest> JUMPI` — a binary-search pivot comparison. */
function gtBranch(asm: Asm, pivot: number, destLabel: string): Asm {
  return asm.dup1().push4(pivot).gt().push2Label(destLabel).jumpi();
}

/** The standard modern selector load: PUSH1 0x00 CALLDATALOAD PUSH1 0xe0 SHR. */
function loadSelectorModern(asm: Asm): Asm {
  return asm.push1(0x00).calldataload().push1(0xe0).shr();
}

/** The old-style selector load: PUSH1 0x00 CALLDATALOAD PUSH29 2^224 SWAP1 DIV. */
function loadSelectorLegacy(asm: Asm): Asm {
  return asm.push1(0x00).calldataload().push29(1n << 224n).swap1().div();
}

/**
 * The WBTC (2019-era) selector load: divisor pushed BEFORE calldataload,
 * DIV lands immediately after, followed by an AND mask. Also uses this
 * dispatcher generation's distinctive first-comparison shape (PUSH4 <sel>
 * DUP2 EQ, dup AFTER the push, vs. the usual DUP1 PUSH4 <sel> EQ).
 */
function loadSelectorWbtcStyle(asm: Asm): Asm {
  return asm.push4(0xffffffff).push29(1n << 224n).push1(0x00).calldataload().div().raw(0x16 /* AND */);
}
function eqBranchDupAfterPush(asm: Asm, selector: number, destLabel: string): Asm {
  return asm.push4(selector).raw(0x81 /* DUP2 */).eq().push2Label(destLabel).jumpi();
}

function revertStub(asm: Asm): Asm {
  return asm.push1(0x00).dup1().revert_();
}

describe("extractDispatcherSelectors — hand-crafted shapes", () => {
  it("recognizes an old-style (DIV) linear dispatcher and extracts only EQ-compared selectors", () => {
    const asm = new Asm();
    loadSelectorLegacy(asm);
    eqBranch(asm, 0xaaaaaaaa, "fn_a");
    eqBranch(asm, 0xbbbbbbbb, "fn_b");
    revertStub(asm);
    asm.label("fn_a").stop();
    asm.label("fn_b").stop();

    const result = extractDispatcherSelectors(asm.assemble());
    expect(result.recognized).toBe(true);
    if (!result.recognized) return;
    expect(result.selectors).toEqual(["0xaaaaaaaa", "0xbbbbbbbb"]);
    expect(result.pivotComparisonCount).toBe(0);
  });

  it("recognizes a modern (SHR) linear dispatcher", () => {
    const asm = new Asm();
    loadSelectorModern(asm);
    eqBranch(asm, 0x12345678, "fn_a");
    revertStub(asm);
    asm.label("fn_a").stop();

    const result = extractDispatcherSelectors(asm.assemble());
    expect(result.recognized).toBe(true);
    if (!result.recognized) return;
    expect(result.selectors).toEqual(["0x12345678"]);
  });

  it("recognizes the WBTC-style old dispatcher: divisor pushed before CALLDATALOAD, DIV+AND mask, and a DUP-after-PUSH4 first comparison", () => {
    const asm = new Asm();
    loadSelectorWbtcStyle(asm);
    eqBranchDupAfterPush(asm, 0x05d2035b, "fn_a"); // the exact shape of WBTC's first real branch
    eqBranch(asm, 0x06fdde03, "fn_b"); // subsequent branches revert to the usual DUP1-before-PUSH4 shape
    revertStub(asm);
    asm.label("fn_a").stop();
    asm.label("fn_b").stop();

    const result = extractDispatcherSelectors(asm.assemble());
    expect(result.recognized).toBe(true);
    if (!result.recognized) return;
    expect(result.selectors).toEqual(["0x05d2035b", "0x06fdde03"]);
  });

  it("recognizes a binary-search dispatcher: GT pivots are counted but never treated as selectors", () => {
    const asm = new Asm();
    loadSelectorModern(asm);
    // pivot splits the space; the pivot value itself (0x50000000) is not a real function.
    gtBranch(asm, 0x50000000, "upper_half");
    // lower half: two real leaves reached only via EQ
    eqBranch(asm, 0x10000000, "fn_low_a");
    eqBranch(asm, 0x20000000, "fn_low_b");
    revertStub(asm);
    asm.label("upper_half");
    eqBranch(asm, 0x60000000, "fn_high_a");
    eqBranch(asm, 0x70000000, "fn_high_b");
    revertStub(asm);
    asm.label("fn_low_a").stop();
    asm.label("fn_low_b").stop();
    asm.label("fn_high_a").stop();
    asm.label("fn_high_b").stop();

    const result = extractDispatcherSelectors(asm.assemble());
    expect(result.recognized).toBe(true);
    if (!result.recognized) return;
    expect(result.selectors).toEqual(["0x10000000", "0x20000000", "0x60000000", "0x70000000"]);
    expect(result.selectors).not.toContain("0x50000000");
    expect(result.pivotComparisonCount).toBe(1);
  });

  it("detects a receive()-shaped empty-calldata guard", () => {
    const asm = new Asm();
    asm.calldatasize().iszero().push2Label("receive").jumpi();
    loadSelectorModern(asm);
    eqBranch(asm, 0x12345678, "fn_a");
    revertStub(asm);
    asm.label("fn_a").stop();
    asm.label("receive").stop();

    const result = extractDispatcherSelectors(asm.assemble());
    expect(result.recognized).toBe(true);
    if (!result.recognized) return;
    expect(result.receiveDetected).toBe(true);
  });

  it("does not claim receive() when no empty-calldata guard is present", () => {
    const asm = new Asm();
    loadSelectorModern(asm);
    eqBranch(asm, 0x12345678, "fn_a");
    revertStub(asm);
    asm.label("fn_a").stop();

    const result = extractDispatcherSelectors(asm.assemble());
    expect(result.recognized).toBe(true);
    if (!result.recognized) return;
    expect(result.receiveDetected).toBe(false);
  });

  it("returns recognized:false for bytecode with no CALLDATALOAD-based selector-load shape", () => {
    // A trivial contract that just returns immediately — no dispatcher at all
    // (e.g. what a hand-written-assembly or Vyper contract might look like).
    const asm = new Asm();
    asm.push1(0x00).push1(0x00).return_();

    const result = extractDispatcherSelectors(asm.assemble());
    expect(result.recognized).toBe(false);
  });

  it("REGRESSION (day-1 edge): a PUSH4/EQ/JUMPI pattern embedded as unreachable data after a terminator is not extracted as a selector", () => {
    // Simulates a factory embedding a child contract's creation bytecode via
    // `new Foo(...)`. The child bytecode below is itself a byte-for-byte
    // valid dispatcher shape (DUP1 PUSH4 <childSelector> EQ PUSH2 JUMPI) —
    // but it sits after the parent's own REVERT stub with no real JUMPDEST
    // pointing into it, exactly as a CODECOPY'd data blob would. A linear
    // walk (day 1's `containsOpcode` approach) would misread it as this
    // contract's own dispatch branch; the reachability-limited walk here
    // must not.
    const asm = new Asm();
    loadSelectorModern(asm);
    eqBranch(asm, 0xaaaaaaaa, "fn_a");
    revertStub(asm); // <-- parent's real control flow ends here, unconditionally
    asm.label("fn_a").stop();
    // Embedded "child creation bytecode" blob — real dispatcher-shaped bytes,
    // but not preceded by a genuine JUMPDEST any parent jump targets.
    const embeddedChild = new Asm();
    embeddedChild.dup1().push4(0xdeadbeef).eq().push2Label("child_fn").jumpi();
    embeddedChild.revert_();
    embeddedChild.label("child_fn").stop();
    const parentHex = asm.assemble();
    const childHex = embeddedChild.assemble();
    const combined = (parentHex + childHex.slice(2)) as Hex;

    const result = extractDispatcherSelectors(combined);
    expect(result.recognized).toBe(true);
    if (!result.recognized) return;
    expect(result.selectors).toEqual(["0xaaaaaaaa"]);
    expect(result.selectors).not.toContain("0xdeadbeef");
  });
});

describe("extractDispatcherSelectors — real mainnet fixtures", () => {
  // WBTC's 2019-era implementation: discovered live during day-2 development
  // that its old-style dispatcher (divisor pushed before CALLDATALOAD, DIV
  // immediately after with a trailing AND mask, and a DUP-after-PUSH4 shape
  // on the first comparison only) was NOT recognized by the initial
  // dispatcher parser, and its first selector was silently dropped by one
  // that recognized the load shape but not the DUP-after-PUSH4 comparison
  // shape — both fixed in dispatcher.ts. This is the regression test.
  it("WBTC (2019-era, old dispatcher variant with DIV+AND and DUP-after-PUSH4 first branch): extracted set exactly matches the known ABI", () => {
    const wbtcSignatures = [
      "mintingFinished()",
      "name()",
      "approve(address,uint256)",
      "reclaimToken(address)",
      "totalSupply()",
      "transferFrom(address,address,uint256)",
      "decimals()",
      "unpause()",
      "mint(address,uint256)",
      "burn(uint256)",
      "claimOwnership()",
      "paused()",
      "decreaseApproval(address,uint256)",
      "balanceOf(address)",
      "renounceOwnership()",
      "finishMinting()",
      "pause()",
      "owner()",
      "symbol()",
      "transfer(address,uint256)",
      "increaseApproval(address,uint256)",
      "allowance(address,address)",
      "pendingOwner()",
      "transferOwnership(address)",
    ];
    const expected = new Set(wbtcSignatures.map(toFunctionSelector));
    const result = extractDispatcherSelectors(loadFixture("wbtc"));
    expect(result.recognized).toBe(true);
    if (!result.recognized) return;
    expect(new Set(result.selectors)).toEqual(expected);
  });


  // WETH9: old-solc (0.4.x), few functions, linear dispatch. Full ABI is
  // exactly these 11 functions — this is an equality assertion, not just a
  // superset, since the whole ABI is known with certainty.
  it("WETH9 (old solc, linear dispatch): extracted set exactly matches the known ABI", () => {
    const weth9Signatures = [
      "name()",
      "approve(address,uint256)",
      "totalSupply()",
      "transferFrom(address,address,uint256)",
      "withdraw(uint256)",
      "decimals()",
      "balanceOf(address)",
      "symbol()",
      "transfer(address,uint256)",
      "deposit()",
      "allowance(address,address)",
    ];
    const expected = new Set(weth9Signatures.map(toFunctionSelector));
    const result = extractDispatcherSelectors(loadFixture("weth9"));
    expect(result.recognized).toBe(true);
    if (!result.recognized) return;
    expect(new Set(result.selectors)).toEqual(expected);
  });

  // USDC's FiatTokenV2_2 implementation: 55 external functions, verified
  // against its published ABI (fetched from a block explorer, not from
  // memory). Large enough to trigger solc's binary-search dispatch — this
  // fixture is what proves GT pivots don't need separate inclusion:
  // solc's binary search always terminates each leaf in a real EQ check.
  it("USDC FiatTokenV2_2 implementation (modern, many-function, binary-search dispatch): extracted set exactly matches the known ABI", () => {
    const usdcSignatures = [
      "CANCEL_AUTHORIZATION_TYPEHASH()",
      "DOMAIN_SEPARATOR()",
      "PERMIT_TYPEHASH()",
      "RECEIVE_WITH_AUTHORIZATION_TYPEHASH()",
      "TRANSFER_WITH_AUTHORIZATION_TYPEHASH()",
      "allowance(address,address)",
      "approve(address,uint256)",
      "authorizationState(address,bytes32)",
      "balanceOf(address)",
      "blacklist(address)",
      "blacklister()",
      "burn(uint256)",
      "cancelAuthorization(address,bytes32,uint8,bytes32,bytes32)",
      "cancelAuthorization(address,bytes32,bytes)",
      "configureMinter(address,uint256)",
      "currency()",
      "decimals()",
      "decreaseAllowance(address,uint256)",
      "increaseAllowance(address,uint256)",
      "initialize(string,string,string,uint8,address,address,address,address)",
      "initializeV2(string)",
      "initializeV2_1(address)",
      "initializeV2_2(address[],string)",
      "isBlacklisted(address)",
      "isMinter(address)",
      "masterMinter()",
      "mint(address,uint256)",
      "minterAllowance(address)",
      "name()",
      "nonces(address)",
      "owner()",
      "pause()",
      "paused()",
      "pauser()",
      "permit(address,address,uint256,uint256,bytes)",
      "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
      "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
      "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
      "removeMinter(address)",
      "rescueERC20(address,address,uint256)",
      "rescuer()",
      "symbol()",
      "totalSupply()",
      "transfer(address,uint256)",
      "transferFrom(address,address,uint256)",
      "transferOwnership(address)",
      "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
      "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
      "unBlacklist(address)",
      "unpause()",
      "updateBlacklister(address)",
      "updateMasterMinter(address)",
      "updatePauser(address)",
      "updateRescuer(address)",
      "version()",
    ];
    const expected = new Set(usdcSignatures.map(toFunctionSelector));
    const result = extractDispatcherSelectors(loadFixture("usdc-impl"));
    expect(result.recognized).toBe(true);
    if (!result.recognized) return;
    expect(result.pivotComparisonCount).toBeGreaterThan(0); // confirms this fixture actually exercises binary-search dispatch
    expect(new Set(result.selectors)).toEqual(expected);
  });

  // Aave v3's PoolAddressesProvider — the exact day-1 fixture that produced
  // a false "unknown" proxy classification because it deploys a child proxy
  // via `new InitializableImmutableAdminUpgradeabilityProxy(...)`, embedding
  // that child's full initcode (including the child's own selector-guarded
  // admin functions) inside its own runtime bytecode. This is THE regression
  // test for the day-1 edge, now applied to selector extraction: the child
  // proxy's admin selectors must not leak into the parent's capability set.
  it("REGRESSION Aave PoolAddressesProvider (embeds a child proxy's initcode via `new`): child selectors absent, own ABI exact", () => {
    const ownSignatures = [
      "getACLAdmin()",
      "getACLManager()",
      "getAddress(bytes32)",
      "getMarketId()",
      "getPool()",
      "getPoolConfigurator()",
      "getPoolDataProvider()",
      "getPriceOracle()",
      "getPriceOracleSentinel()",
      "owner()",
      "renounceOwnership()",
      "setACLAdmin(address)",
      "setACLManager(address)",
      "setAddress(bytes32,address)",
      "setAddressAsProxy(bytes32,address)",
      "setMarketId(string)",
      "setPoolConfiguratorImpl(address)",
      "setPoolDataProvider(address)",
      "setPoolImpl(address)",
      "setPriceOracle(address)",
      "setPriceOracleSentinel(address)",
      "transferOwnership(address)",
    ];
    const expected = new Set(ownSignatures.map(toFunctionSelector));

    // Selectors that belong to the embedded child
    // (InitializableImmutableAdminUpgradeabilityProxy / TransparentUpgradeableProxy-shaped
    // admin functions) and must NOT appear in the parent's extracted set.
    const childOnlySignatures = [
      "admin()",
      "implementation()",
      "changeAdmin(address)",
      "upgradeTo(address)",
      "upgradeToAndCall(address,bytes)",
    ];

    const result = extractDispatcherSelectors(loadFixture("aave-pool-addresses-provider"));
    expect(result.recognized).toBe(true);
    if (!result.recognized) return;

    expect(new Set(result.selectors)).toEqual(expected);
    for (const sig of childOnlySignatures) {
      expect(result.selectors).not.toContain(toFunctionSelector(sig));
    }
  });
});
