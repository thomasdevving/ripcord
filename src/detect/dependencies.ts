/**
 * One-level-deep dependency graph: for a target contract, checks whether it
 * holds a meaningful balance of any token on the curated MAJOR_TOKENS list
 * and, for each one it does, re-runs day-1 proxy/authority detection plus
 * day-2 capability detection against the TOKEN itself — a protocol can be
 * impeccably governed and still not be sovereign if what it holds can be
 * frozen by someone else. Separately probes for oracle/price-feed
 * references and runs authority detection (not full capability detection —
 * deliberately shallower, since an oracle is a dependency-of-a-dependency,
 * one hop further than this file's own "one level deep" mandate) on any
 * that resolve.
 *
 * Depth is exactly one level, on purpose — see day-2 brief and CLAUDE.md.
 */
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Hex } from "viem";
import type { ChainReader } from "../chain/client.js";
import { erc20Abi, oracleGetterAbi } from "../chain/abi.js";
import { MAJOR_TOKENS } from "../chain/majorTokens.js";
import { detectProxy } from "./proxy.js";
import { detectOwnership } from "./ownership.js";
import { detectAccessControl } from "./accessControl.js";
import { detectCapabilities } from "./capabilities.js";
import { collectPowerHolders } from "./accounts.js";
import type { DependencyGraph, OracleDependency, TokenDependency, UnknownEntry } from "../report/schema.js";

const ORACLE_GETTERS = ["oracle", "priceOracle", "priceFeed"] as const;

/** A balance is "meaningful" if non-zero — day 2 does not attempt a USD-value threshold (would require pricing every token, out of scope). */
function isMeaningfulBalance(balance: bigint): boolean {
  return balance > 0n;
}

export interface DependencyDetection {
  result: DependencyGraph;
  unknowns: UnknownEntry[];
}

export async function detectDependencies(chain: ChainReader, target: Hex): Promise<DependencyDetection> {
  const unknowns: UnknownEntry[] = [];
  const tokens: TokenDependency[] = [];
  const candidates = MAJOR_TOKENS[chain.chainId] ?? [];

  for (const { address: tokenAddress } of candidates) {
    const balanceCall = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [target] });
    const { result, reverted, evidence: balanceEvidence } = await chain.call(tokenAddress, balanceCall);
    if (reverted || !result) continue;

    let balance: bigint;
    try {
      balance = decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: result }) as bigint;
    } catch {
      continue;
    }
    if (!isMeaningfulBalance(balance)) continue;

    const proxy = await detectProxy(chain, tokenAddress);
    const ownership = await detectOwnership(chain, tokenAddress);
    const accessControl = await detectAccessControl(chain, tokenAddress);
    unknowns.push(
      ...accessControl.unknowns.map((u) => ({ field: `dependencies.tokens[${tokenAddress}].${u.field}`, reason: u.reason })),
    );

    const capabilities = await detectCapabilities(
      chain,
      tokenAddress,
      proxy,
      ownership.owner.address as Hex | null,
      accessControl.result.roles,
    );
    unknowns.push(
      ...capabilities.unknowns.map((u) => ({ field: `dependencies.tokens[${tokenAddress}].${u.field}`, reason: u.reason })),
    );

    const capabilityHolders = capabilities.result.findings
      .filter((f) => f.guard.status === "attributed")
      .flatMap((f) =>
        (f.guard as Extract<typeof f.guard, { status: "attributed" }>).holders.map((address) => ({
          address,
          label: f.signature,
        })),
      );
    const powerHolders = await collectPowerHolders(chain, {
      owner: ownership.owner.address as Hex | null,
      pendingOwner: ownership.pendingOwner.address as Hex | null,
      proxyAdmin: proxy.admin as Hex | null,
      accessControlRoles: accessControl.result.roles,
      capabilityHolders,
    });

    tokens.push({
      token: tokenAddress,
      balance: balance.toString(),
      balanceEvidence: [balanceEvidence],
      proxy,
      authority: { owner: ownership.owner, pendingOwner: ownership.pendingOwner, accessControl: accessControl.result },
      capabilities: capabilities.result,
      powerHolders,
    });
  }

  const oracles = await detectOracles(chain, target, unknowns);

  return { result: { tokens, oracles }, unknowns };
}

async function detectOracles(chain: ChainReader, target: Hex, unknowns: UnknownEntry[]): Promise<OracleDependency[]> {
  const oracles: OracleDependency[] = [];
  const seen = new Set<string>();

  for (const fnName of ORACLE_GETTERS) {
    const data = encodeFunctionData({ abi: oracleGetterAbi, functionName: fnName });
    const { result, reverted } = await chain.call(target, data);
    if (reverted || !result) continue;

    let addr: Hex;
    try {
      addr = decodeFunctionResult({ abi: oracleGetterAbi, functionName: fnName, data: result }) as Hex;
    } catch {
      continue;
    }
    if (addr.toLowerCase() === zeroAddress) continue;
    if (seen.has(addr.toLowerCase())) continue;
    seen.add(addr.toLowerCase());

    const { code } = await chain.getCode(addr);
    if (!code) continue; // an oracle getter returning an EOA is not a real dependency to chase

    const ownership = await detectOwnership(chain, addr);
    const accessControl = await detectAccessControl(chain, addr);
    unknowns.push(
      ...accessControl.unknowns.map((u) => ({ field: `dependencies.oracles[${addr}].${u.field}`, reason: u.reason })),
    );
    const powerHolders = await collectPowerHolders(chain, {
      owner: ownership.owner.address as Hex | null,
      pendingOwner: ownership.pendingOwner.address as Hex | null,
      accessControlRoles: accessControl.result.roles,
    });

    oracles.push({
      source: `${fnName}()`,
      address: addr,
      authority: { owner: ownership.owner, pendingOwner: ownership.pendingOwner, accessControl: accessControl.result },
      powerHolders,
    });
  }

  return oracles;
}
