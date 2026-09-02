/**
 * Evidence-first check for the day-5 authority-INDIRECTION marker: which
 * zero-arg getters actually resolve on a given contract at the pinned block.
 * The design question is whether a marker probe can honestly distinguish
 * "delegates its authority elsewhere" from "has no authority at all", and that
 * is settled by reading the chain, not by picking names that sound right.
 */
import { createPublicClient, http, type Hex } from "viem";
import { mainnet } from "viem/chains";
const SELECTORS: Record<string, string> = {
  "0xaaabadc5": "getAuthorizer()", "0xbf7e214f": "authority()", "0xde287359": "acl()",
  "0x392f5f64": "roles()", "0x51331ad7": "getRoleManager()", "0xf851a440": "admin()",
  "0x6e9960c3": "getAdmin()", "0x7b103999": "registry()", "0xf77c4791": "controller()",
  "0x0c340a24": "governor()", "0x5aa6e675": "governance()", "0x67601a8e": "rocketStorage()",
  "0x3408f73a": "getStorage()", "0xfdcb6068": "accessManager()", "0xd09edf31": "authorizer()",
  "0x481c6a75": "manager()", "0x40298ed7": "aclManager()", "0x707cd716": "getACLManager()",
};
async function main() {
  process.loadEnvFile(".env");
  const client = createPublicClient({ chain: mainnet, transport: http(process.env.RPC_URL_1!) });
  const BLOCK = 25800000n;
  for (const addr of process.argv.slice(2)) {
    const hits: string[] = [];
    for (const [sel, sig] of Object.entries(SELECTORS)) {
      try {
        const res = await client.call({ to: addr as Hex, data: sel as Hex, blockNumber: BLOCK });
        if (res.data && res.data !== "0x") hits.push(`${sig}=${res.data.slice(0, 66)}`);
      } catch { /* revert = the getter is absent or reverts; either way not a marker */ }
    }
    console.log(`${addr}\n  ${hits.length ? hits.join("\n  ") : "(no indirection marker resolves)"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
