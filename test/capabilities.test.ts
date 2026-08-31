import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keccak256, toBytes, toHex, type Hex } from "viem";
import { detectCapabilities } from "../src/detect/capabilities.js";
import { detectProxy } from "../src/detect/proxy.js";
import type { ChainReader, Evidence } from "../src/chain/client.js";

function loadFixture(name: string): Hex {
  return readFileSync(join(__dirname, "fixtures/bytecode", `${name}.hex`), "utf8").trim() as Hex;
}

function eip1967Slot(label: string): Hex {
  const hash = BigInt(keccak256(toBytes(label)));
  return toHex(hash - 1n, { size: 32 });
}
const IMPL_SLOT = eip1967Slot("eip1967.proxy.implementation");
const ADMIN_SLOT = eip1967Slot("eip1967.proxy.admin");
const ZERO_SLOT = ("0x" + "0".repeat(64)) as Hex;

function addressToSlot(address: Hex): Hex {
  return ("0x" + "0".repeat(24) + address.slice(2).toLowerCase()) as Hex;
}

/**
 * Fake ChainReader for capabilities.test.ts: `codeByAddress` supplies real
 * bytecode fixtures, `storage` supplies proxy slot values, and every
 * `probeCall` uniformly reports "no revert" — guard-probing logic itself is
 * already thoroughly covered in guardProbe.test.ts, so this fake keeps that
 * part inert and lets these tests focus on proxy resolution + taxonomy
 * wiring, which is what capabilities.ts is actually responsible for.
 */
function fakeChain(
  codeByAddress: Record<string, Hex | undefined>,
  storage: Record<string, Hex> = {},
  probedAddresses: Hex[] = [],
): ChainReader {
  return {
    chainId: 1,
    blockNumber: 1n,
    async getBlockHash() {
      return "0x0" as Hex;
    },
    async getCodeAtBlock() {
      return { code: undefined };
    },
    async getCode(address: Hex) {
      const code = codeByAddress[address.toLowerCase()];
      return { code, evidence: { kind: "bytecode", params: { address }, rawValue: code ?? "0x", block: "1" } as Evidence };
    },
    async getStorageAt(address: Hex, slot: Hex) {
      const value = storage[`${address.toLowerCase()}:${slot.toLowerCase()}`] ?? ZERO_SLOT;
      return { value, evidence: { kind: "storage_slot", params: { address, slot }, rawValue: value, block: "1" } as Evidence };
    },
    async call() {
      return { result: undefined, reverted: true, evidence: {} as Evidence };
    },
    async probeCall(address: Hex, data: Hex, from: Hex) {
      probedAddresses.push(address);
      return {
        revertData: undefined,
        reverted: false,
        evidence: { kind: "call", params: { address, data, from }, rawValue: "0x", block: "1" } as Evidence,
      };
    },
    async getLogs() {
      return { logs: [], evidence: {} as Evidence };
    },
  };
}

describe("detectCapabilities — proxy resolution", () => {
  it("for a transparent EIP-1967 proxy, scans the IMPLEMENTATION's bytecode, not the proxy's, and records which address was scanned", async () => {
    const proxyAddress = ("0x" + "11".repeat(20)) as Hex;
    const implAddress = ("0x" + "22".repeat(20)) as Hex;
    const adminAddress = ("0x" + "33".repeat(20)) as Hex;

    const chain = fakeChain(
      {
        [proxyAddress.toLowerCase()]: "0x6080604052" as Hex, // some placeholder proxy bytecode, never dispatcher-scanned
        [implAddress.toLowerCase()]: loadFixture("weth9"), // real bytecode with a known ABI
      },
      {
        [`${proxyAddress.toLowerCase()}:${IMPL_SLOT.toLowerCase()}`]: addressToSlot(implAddress),
        [`${proxyAddress.toLowerCase()}:${ADMIN_SLOT.toLowerCase()}`]: addressToSlot(adminAddress),
      },
    );

    const proxy = await detectProxy(chain, proxyAddress);
    expect(proxy.pattern).toBe("eip1967_transparent");
    expect(proxy.implementation?.toLowerCase()).toBe(implAddress.toLowerCase());

    const detection = await detectCapabilities(chain, proxyAddress, proxy, null, []);

    expect(detection.result.dispatcherRecognized).toBe(true);
    expect(detection.result.scannedAddress?.toLowerCase()).toBe(implAddress.toLowerCase());
    // Every finding must also report the implementation as its scannedAddress.
    for (const finding of detection.result.findings) {
      expect(finding.scannedAddress.toLowerCase()).toBe(implAddress.toLowerCase());
    }
  });

  it("REGRESSION: guard probes are sent to the PROXY, never to the implementation", async () => {
    // A delegatecall through the proxy runs the implementation's code against
    // the PROXY's storage, which is where owner/role state lives. Probing the
    // implementation directly runs the same code against the implementation's
    // own, usually uninitialized, storage — so any revert it produces says
    // nothing about who controls the proxy. Verified live on PAID Network:
    // the proxy's owner() is 0x53bc21D3…, the implementation's own owner() is
    // address(0), yet BOTH revert "Ownable: caller is not the owner" for an
    // unrelated caller. Attributing the implementation's revert to the
    // proxy's owner would be an attribution the evidence doesn't support.
    const proxyAddress = ("0x" + "aa".repeat(20)) as Hex;
    const implAddress = ("0x" + "bb".repeat(20)) as Hex;
    const adminAddress = ("0x" + "cc".repeat(20)) as Hex;
    const probed: Hex[] = [];

    const chain = fakeChain(
      {
        [proxyAddress.toLowerCase()]: "0x6080604052" as Hex,
        // Aave's fixture has real taxonomy-matching selectors, so probes fire.
        [implAddress.toLowerCase()]: loadFixture("aave-pool-addresses-provider"),
      },
      {
        [`${proxyAddress.toLowerCase()}:${IMPL_SLOT.toLowerCase()}`]: addressToSlot(implAddress),
        [`${proxyAddress.toLowerCase()}:${ADMIN_SLOT.toLowerCase()}`]: addressToSlot(adminAddress),
      },
      probed,
    );

    const proxy = await detectProxy(chain, proxyAddress);
    const detection = await detectCapabilities(chain, proxyAddress, proxy, null, []);

    expect(probed.length).toBeGreaterThan(0); // probes actually ran
    for (const addr of probed) {
      expect(addr.toLowerCase()).toBe(proxyAddress.toLowerCase());
      expect(addr.toLowerCase()).not.toBe(implAddress.toLowerCase());
    }
    // The report must state both addresses, since they differ and the
    // distinction is what makes the guard evidence meaningful.
    expect(detection.result.scannedAddress?.toLowerCase()).toBe(implAddress.toLowerCase());
    expect(detection.result.probedAddress.toLowerCase()).toBe(proxyAddress.toLowerCase());
    for (const entry of detection.result.needsManualVerification) {
      expect(entry.scannedAddress.toLowerCase()).toBe(implAddress.toLowerCase());
      expect(entry.probedAddress.toLowerCase()).toBe(proxyAddress.toLowerCase());
    }
  });

  it("for a non-proxy target, scans the target's own bytecode", async () => {
    const target = ("0x" + "44".repeat(20)) as Hex;
    const chain = fakeChain({ [target.toLowerCase()]: loadFixture("weth9") });

    const proxy = await detectProxy(chain, target);
    expect(proxy.isProxy).toBe(false);

    const detection = await detectCapabilities(chain, target, proxy, null, []);
    expect(detection.result.scannedAddress?.toLowerCase()).toBe(target.toLowerCase());
  });

  it("WETH9 (no privileged functions in the taxonomy) produces zero capability findings", async () => {
    const target = ("0x" + "55".repeat(20)) as Hex;
    const chain = fakeChain({ [target.toLowerCase()]: loadFixture("weth9") });
    const proxy = await detectProxy(chain, target);

    const detection = await detectCapabilities(chain, target, proxy, null, []);
    expect(detection.result.findings).toEqual([]);
    expect(detection.result.needsManualVerification).toEqual([]);
  });

  it("Aave PoolAddressesProvider surfaces its real taxonomy-matched capabilities, categorized correctly (also proves the pattern='unknown' fallback: day 1 misclassifies this exact contract as isProxy:true/implementation:null due to its embedded child, per CLAUDE.md known edges)", async () => {
    const target = ("0x" + "66".repeat(20)) as Hex;
    const chain = fakeChain({ [target.toLowerCase()]: loadFixture("aave-pool-addresses-provider") });
    const proxy = await detectProxy(chain, target);
    expect(proxy.pattern).toBe("unknown"); // the day-1 known edge this test also exercises

    const detection = await detectCapabilities(chain, target, proxy, null, []);
    expect(detection.result.scannedAddress?.toLowerCase()).toBe(target.toLowerCase());
    // This fake's probeCall always reports "no revert" from every probe address
    // — i.e. no auth-shaped revert was ever observed — so per the weakest-link
    // routing rule (see guardProbe.ts / capabilities.ts) these land in
    // needsManualVerification, not findings. That routing itself is exercised
    // directly in guardProbe.test.ts; this test only cares that the taxonomy
    // match + categorization happened correctly.
    expect(detection.result.findings).toEqual([]);
    const byCategory = new Map(detection.result.needsManualVerification.map((f) => [f.signature, f.category]));
    expect(byCategory.get("transferOwnership(address)")).toBe("AUTHORITY_CHANGE");
    expect(byCategory.get("renounceOwnership()")).toBe("AUTHORITY_CHANGE");
    expect(byCategory.get("setPriceOracle(address)")).toBe("ECONOMIC");
  });

  it("reports how many selectors were extracted and which ones matched no taxonomy entry", async () => {
    // Without this, a contract exposing many functions of which Ripcord
    // classifies two would look identical to a contract that only has two.
    const target = ("0x" + "88".repeat(20)) as Hex;
    const chain = fakeChain({ [target.toLowerCase()]: loadFixture("weth9") });
    const proxy = await detectProxy(chain, target);

    const detection = await detectCapabilities(chain, target, proxy, null, []);
    const c = detection.result;

    // WETH9's full ABI is 11 functions, none of them privileged.
    expect(c.selectorsExtracted).toBe(11);
    expect(c.unmatchedSelectors).toHaveLength(11);
    expect(c.findings).toEqual([]);
    expect(c.needsManualVerification).toEqual([]);
    // Every selector is accounted for: classified, or explicitly unmatched.
    expect(c.findings.length + c.needsManualVerification.length + c.unmatchedSelectors.length).toBe(
      c.selectorsExtracted,
    );
  });

  it("returns dispatcherRecognized:false and an unknowns entry when there is no code at the scan address", async () => {
    const target = ("0x" + "77".repeat(20)) as Hex;
    const chain = fakeChain({ [target.toLowerCase()]: undefined });
    const proxy = await detectProxy(chain, target);

    const detection = await detectCapabilities(chain, target, proxy, null, []);
    expect(detection.result.dispatcherRecognized).toBe(false);
    expect(detection.unknowns.length).toBeGreaterThan(0);
  });
});
