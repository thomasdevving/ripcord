import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { mainnet } from "viem/chains";
async function main() {
  process.loadEnvFile(".env");
  const client = createPublicClient({ chain: mainnet, transport: http(process.env.RPC_URL_1!) });
  const BLOCK = 25800000n;
  const abi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]);
  for (const t of process.argv.slice(2)) {
    const [label, addr] = t.split("=");
    const code = await client.getCode({ address: addr as Hex, blockNumber: BLOCK });
    let name = "-", symbol = "-";
    try { name = await client.readContract({ address: addr as Hex, abi, functionName: "name", blockNumber: BLOCK }) as string; } catch {}
    try { symbol = await client.readContract({ address: addr as Hex, abi, functionName: "symbol", blockNumber: BLOCK }) as string; } catch {}
    console.log([label, addr, code ? `code:${(code.length - 2) / 2}b` : "NO CODE", `name=${name}`, `symbol=${symbol}`].join(" | "));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
