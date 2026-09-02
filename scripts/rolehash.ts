/** Derive keccak256 of role-name preimages, so a role hash is IDENTIFIED by derivation, never recognised from memory. */
import { keccak256, toBytes } from "viem";
for (const n of process.argv.slice(2)) console.log(keccak256(toBytes(n)), n);
