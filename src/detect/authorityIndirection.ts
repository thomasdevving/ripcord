/**
 * Authority INDIRECTION markers (day 5, from calibration).
 *
 * This module detects that a contract delegates its authorisation to some other
 * contract. It deliberately does NOT resolve what that contract is, who
 * controls it, or what it permits. Its entire job is to turn "Ripcord found no
 * authority" into "Ripcord found a handle to authority it does not follow" —
 * which is the difference between an absence of evidence and evidence of
 * absence, and therefore the difference between an honest `undetermined` and a
 * false clean bill.
 *
 * WHY IT EXISTS. Day-5 calibration ran three contracts into
 * `no_rule_change_route_found`, and two of them were wrong in the one direction
 * this project cannot afford:
 *   - Balancer Vault (0xBA122222…) exposes `getAuthorizer()` → a separate
 *     TimelockAuthorizer holding every permission over the Vault. No owner, no
 *     roles, no proxy — so every day-1 check came back empty and the verdict
 *     read as "no exit-window risk was identified."
 *   - rETH (0xae78736C…) checks callers against a RocketStorage registry it
 *     does not expose at all.
 * The first is catchable with a two-selector probe. The second is not, and that
 * is precisely why the fix cannot stop here: the assessment's DEFAULT was also
 * inverted (see exitWindow.ts) so that "clean" is a positive claim requiring
 * positive evidence, and an undetected bespoke registry lands in `undetermined`
 * rather than in a pass.
 *
 * SCOPE, held deliberately narrow. A marker is one zero-argument getter that
 * returns a non-zero address. That is the whole test. Ripcord does not call
 * into the returned contract, does not enumerate its permissions, and never
 * claims the marker proves power exists — only that a documented handle to
 * authority is present and unresolved. Following it would be a resolution
 * layer, and a resolution layer for arbitrary authorisation modules is a much
 * larger piece of work than day 5 has room for (see KNOWN EDGES).
 *
 * The consequence of a marker is always conservative: it can only ever move an
 * assessment toward `undetermined`. It can never establish a window, shorten
 * one, or attribute power to anybody. A false positive here therefore costs a
 * lost "immutable" claim and nothing else, which is why the list can afford to
 * be a little generous while the non-zero-address requirement keeps it honest.
 */
import { decodeAbiParameters, toFunctionSelector, type Hex } from "viem";
import type { ChainReader, Evidence } from "../chain/client.js";

/** Bump when a getter is added or removed. Recorded in the report. */
export const authorityIndirectionVersion = "0.1.0";

/**
 * Zero-argument getters that name a contract holding authority over the target.
 *
 * These are authorisation handles, not general getters: each one, when a real
 * protocol exposes it, points at the thing that decides who may do what. The
 * selectors are DERIVED from the signatures below at module load, never copied.
 */
export const INDIRECTION_GETTERS: readonly string[] = [
  // Delegated-authorisation modules.
  "getAuthorizer()", // Balancer v2 → TimelockAuthorizer. Read live at block 25800000.
  "authorizer()",
  "authority()", // ds-auth / DSAuth, and OpenZeppelin AccessManaged's older shape.
  "accessManager()", // OpenZeppelin v5 AccessManager.
  "acl()", // Aragon-style access control list.
  "aclManager()", // Aave v3 ACLManager, when a contract exposes it.
  "getACLManager()",
  "getRoleManager()",
  // Admin handles Ripcord's day-1 ownership detection does not read. `admin()`
  // is how Compound's delegator pattern (cDAI, Unitroller) exposes its
  // controller — day-1 reads owner()/pendingOwner() only, so those contracts
  // present as authority-free without this.
  "admin()",
  "getAdmin()",
  // Governance handles.
  "governance()",
  "governor()",
  "controller()",
  "registry()",
] as const;

export interface IndirectionMarker {
  /** The getter that resolved. */
  signature: string;
  selector: Hex;
  /** The non-zero address it returned. NOT resolved further — that is the point. */
  target: Hex;
  evidence: Evidence;
}

export interface AuthorityIndirectionResult {
  version: string;
  /** Every getter that was actually called, so an empty `markers` means "checked, none found". */
  gettersProbed: string[];
  markers: IndirectionMarker[];
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Probes each getter at the pinned block. A revert, empty return, or zero
 * address means the getter is absent or unset — in all three cases there is no
 * marker, and no claim is made either way about authority.
 *
 * Reverts here are ordinary evidence-carrying results (see client.ts), not
 * errors: most of these getters are absent on most contracts, which is the
 * normal case rather than a failure.
 */
export async function detectAuthorityIndirection(
  chain: ChainReader,
  target: Hex,
): Promise<AuthorityIndirectionResult> {
  const markers: IndirectionMarker[] = [];
  for (const signature of INDIRECTION_GETTERS) {
    const selector = toFunctionSelector(`function ${signature}`) as Hex;
    const { reverted, result, evidence } = await chain.call(target, selector);
    if (reverted || !result || result === "0x") continue;
    // A getter returning something that is not one 32-byte word is not the
    // address-returning accessor we are looking for — a same-named function
    // with a different return type must not be read as a marker.
    if (result.length !== 66) continue;
    let decoded: Hex;
    try {
      [decoded] = decodeAbiParameters([{ type: "address" }], result) as [Hex];
    } catch {
      continue;
    }
    if (decoded.toLowerCase() === ZERO) continue;
    markers.push({ signature, selector, target: decoded, evidence });
  }
  return { version: authorityIndirectionVersion, gettersProbed: [...INDIRECTION_GETTERS], markers };
}
