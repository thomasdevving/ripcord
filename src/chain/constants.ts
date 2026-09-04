/**
 * All storage slots and function selectors used by Ripcord are derived here
 * from their preimages, not copied from memory or a blog post. If a derived
 * value ever disagrees with a known reference value, the derivation is
 * authoritative — see test/constants.test.ts, which asserts both.
 */
import { keccak256, toBytes, toHex, toFunctionSelector, type Hex } from "viem";

/** keccak256(utf8(label)) - 1, as a 32-byte left-padded hex slot. EIP-1967 slot derivation rule. */
function eip1967Slot(label: string): Hex {
  const hash = BigInt(keccak256(toBytes(label)));
  const slot = hash - 1n;
  return toHex(slot, { size: 32 });
}

export const SLOTS = {
  /** EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1 */
  eip1967Implementation: eip1967Slot("eip1967.proxy.implementation"),

  /** EIP-1967 admin slot: keccak256("eip1967.proxy.admin") - 1 */
  eip1967Admin: eip1967Slot("eip1967.proxy.admin"),

  /** EIP-1967 beacon slot: keccak256("eip1967.proxy.beacon") - 1 */
  eip1967Beacon: eip1967Slot("eip1967.proxy.beacon"),

  /**
   * EIP-1822 UUPS "PROXIABLE" slot: keccak256("PROXIABLE"), no subtraction.
   * A UUPS implementation stores its own address here so it can assert
   * `proxiableUUID() == PROXIABLE_SLOT` during an upgrade.
   */
  eip1822Proxiable: keccak256(toBytes("PROXIABLE")),

  /**
   * Legacy "unstructured storage" proxy slots predating EIP-1967, used by early
   * OpenZeppelin (zos-lib / openzeppelin-sdk, pre-2.0) upgradeable proxies:
   *   implementation: keccak256("org.zeppelinos.proxy.implementation")
   *   admin:          keccak256("org.zeppelinos.proxy.admin")
   * Note: no "- 1" here — the legacy scheme predates EIP-1967's collision
   * convention.
   */
  legacyZosImplementation: keccak256(toBytes("org.zeppelinos.proxy.implementation")),
  legacyZosAdmin: keccak256(toBytes("org.zeppelinos.proxy.admin")),
} as const;

export const SELECTORS = {
  /**
   * Not in the brief's day-1 selector list, but required to fulfil the
   * "resolve one hop through the beacon" requirement for beacon proxies:
   * OpenZeppelin's UpgradeableBeacon exposes `implementation()`.
   */
  implementation: toFunctionSelector("implementation()"),
  owner: toFunctionSelector("owner()"),
  pendingOwner: toFunctionSelector("pendingOwner()"),
  getOwners: toFunctionSelector("getOwners()"),
  getThreshold: toFunctionSelector("getThreshold()"),
  VERSION: toFunctionSelector("VERSION()"),
  nonce: toFunctionSelector("nonce()"),
  hasRole: toFunctionSelector("hasRole(bytes32,address)"),
  getRoleAdmin: toFunctionSelector("getRoleAdmin(bytes32)"),
  DEFAULT_ADMIN_ROLE: toFunctionSelector("DEFAULT_ADMIN_ROLE()"),
  getRoleMemberCount: toFunctionSelector("getRoleMemberCount(bytes32)"),
  getRoleMember: toFunctionSelector("getRoleMember(bytes32,uint256)"),
} as const;

/**
 * Timelock accessors, derived from signatures like every other selector here.
 * Two dominant families, detected by their delay accessor:
 *   - OpenZeppelin TimelockController exposes `getMinDelay()` and is
 *     AccessControl-based. Its delay changes only through a scheduled
 *     `updateDelay(uint256)` the timelock issues to itself, subject to the
 *     current delay.
 *   - Compound / Governor-Bravo Timelock exposes `delay()` plus `admin()`,
 *     `GRACE_PERIOD()`, `MINIMUM_DELAY()`, `MAXIMUM_DELAY()`, and changes its
 *     delay via `setDelay(uint256)` (guarded by `msg.sender == address(this)`).
 * `updateDelay`/`setDelay` are what the "can the admin shorten its own delay?"
 * sub-finding probes for in bytecode.
 */
export const TIMELOCK_SELECTORS = {
  getMinDelay: toFunctionSelector("getMinDelay()"),
  delay: toFunctionSelector("delay()"),
  admin: toFunctionSelector("admin()"),
  GRACE_PERIOD: toFunctionSelector("GRACE_PERIOD()"),
  MINIMUM_DELAY: toFunctionSelector("MINIMUM_DELAY()"),
  MAXIMUM_DELAY: toFunctionSelector("MAXIMUM_DELAY()"),
  updateDelay: toFunctionSelector("updateDelay(uint256)"),
  setDelay: toFunctionSelector("setDelay(uint256)"),
} as const;

/**
 * EIP-1167 minimal proxy (clone) runtime bytecode, split around the 20-byte
 * target address so callers can match a prefix/suffix pair against arbitrary
 * runtime code. Two variants exist in the wild: the original push20 form and
 * a push20-with-extra-push0 "vanity address" variant used by some factories.
 */
export const EIP1167_CLONE = {
  prefix: "0x363d3d373d3d3d363d73",
  suffix: "0x5af43d82803e903d91602b57fd5bf3",
} as const;

/** Well-known AccessControl role name -> hash, for resolving hashes we can recognise. */
export const KNOWN_ROLE_HASHES: Record<Hex, string> = {
  [toHex(0n, { size: 32 })]: "DEFAULT_ADMIN_ROLE",
  [keccak256(toBytes("MINTER_ROLE"))]: "MINTER_ROLE",
  [keccak256(toBytes("PAUSER_ROLE"))]: "PAUSER_ROLE",
  [keccak256(toBytes("BURNER_ROLE"))]: "BURNER_ROLE",
  [keccak256(toBytes("UPGRADER_ROLE"))]: "UPGRADER_ROLE",
  [keccak256(toBytes("GOVERNANCE_ROLE"))]: "GOVERNANCE_ROLE",
  [keccak256(toBytes("OPERATOR_ROLE"))]: "OPERATOR_ROLE",
  [keccak256(toBytes("GUARDIAN_ROLE"))]: "GUARDIAN_ROLE",
  [keccak256(toBytes("TIMELOCK_ADMIN_ROLE"))]: "TIMELOCK_ADMIN_ROLE",
  [keccak256(toBytes("PROPOSER_ROLE"))]: "PROPOSER_ROLE",
  [keccak256(toBytes("EXECUTOR_ROLE"))]: "EXECUTOR_ROLE",
  [keccak256(toBytes("CANCELLER_ROLE"))]: "CANCELLER_ROLE",
};

export const RELEVANT_EVENTS = {
  roleGranted: "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  roleRevoked: "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  ownershipTransferred: "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  upgraded: "event Upgraded(address indexed implementation)",
  adminChanged: "event AdminChanged(address previousAdmin, address newAdmin)",
  beaconUpgraded: "event BeaconUpgraded(address indexed beacon)",
} as const;
