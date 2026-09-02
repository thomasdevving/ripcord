/**
 * Hand-verification helper for the day-5 rolePrivilege calibration.
 *
 * Performs a raw eth_call at the pinned block from a chosen `from` address and
 * prints the raw return/revert bytes. The point is to establish what a role
 * ACTUALLY does on-chain — whether holding it grants power over others, or
 * (the sUSDe case) removes power from the holder — by observation rather than
 * by reading a name and assuming.
 *
 * usage: probe-call.ts <to> <calldata> <from>...
 */
import { createPublicClient, http, type Hex } from "viem";
import { mainnet } from "viem/chains";

async function main() {
  process.loadEnvFile(".env");
  const client = createPublicClient({ chain: mainnet, transport: http(process.env.RPC_URL_1!) });
  const BLOCK = BigInt(process.env.PROBE_BLOCK ?? "25800000");
  const [to, data, ...froms] = process.argv.slice(2);
  for (const from of froms) {
    try {
      const res = await client.call({ to: to as Hex, data: data as Hex, account: from as Hex, blockNumber: BLOCK });
      console.log(`from ${from}  -> OK   ${res.data ?? "0x"}`);
    } catch (e: any) {
      const raw = e?.cause?.data ?? e?.data ?? e?.cause?.cause?.data;
      const short = e?.shortMessage ?? e?.message ?? String(e);
      console.log(`from ${from}  -> REVERT ${typeof raw === "string" ? raw : "(no data)"}  | ${String(short).split("\n")[0].slice(0, 110)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
