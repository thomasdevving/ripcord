/**
 * Prints what an eth_call failure actually looks like from a live provider, so
 * `looksLikeContractRevert` (src/chain/client.ts) is derived from an observation
 * rather than from memory. Genuine reverts carry ExecutionRevertedError + RPC
 * code 3 + "execution reverted"; infrastructure failures carry none of those and
 * match none of the transient patterns either.
 *
 * Run: npx tsx scripts/audit-error-shapes.ts   (needs RPC_URL_1)
 * The shapes are pinned in test/readFailures.test.ts, so CI needs no network.
 */
process.loadEnvFile(".env");
import { createPublicClient, http, encodeFunctionData } from "viem";

const rpc = process.env.RPC_URL_1!;
const BLOCK = 25800000n;

function describe(err: unknown) {
  const chain: string[] = [];
  let cur: any = err;
  for (let d = 0; cur && d < 10; d++) {
    chain.push(
      `    [${d}] name=${cur.name ?? "?"} code=${JSON.stringify(cur.code)} ` +
      `data=${typeof cur.data === "string" ? cur.data.slice(0, 30) : JSON.stringify(cur.data)} ` +
      `details=${JSON.stringify(String(cur.details ?? "").slice(0, 90))} ` +
      `msg=${JSON.stringify(String(cur.message ?? "").split("\n")[0].slice(0, 90))}`,
    );
    cur = cur.cause;
  }
  return chain.join("\n");
}

async function attempt(label: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    console.log(`\n### ${label}\n  OK -> ${JSON.stringify(r).slice(0, 120)}`);
  } catch (err) {
    console.log(`\n### ${label}\n  THREW:\n${describe(err)}`);
  }
}

const client = createPublicClient({ transport: http(rpc) });
const badClient = createPublicClient({ transport: http("https://eth-mainnet.g.alchemy.com/v2/definitely-not-a-real-key-000") });

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const owner = encodeFunctionData({ abi: [{ type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }] });
const transferFrom0 = encodeFunctionData({
  abi: [{ type: "function", name: "transferFrom", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }],
  args: ["0x000000000000000000000000000000000000dEaD", "0x000000000000000000000000000000000000dEaD", 10n ** 30n],
});

async function main() {
  // 1. A revert with NO data: WETH9 has no owner(), the compiler's fallback just reverts.
  await attempt("revert, no data (WETH9.owner())", () => client.call({ to: WETH, data: owner, blockNumber: BLOCK }));
  // 2. A revert WITH an Error(string) payload: transferFrom of an impossible amount.
  await attempt("revert with Error(string) (USDC.transferFrom huge)", () => client.call({ to: USDC, data: transferFrom0, blockNumber: BLOCK }));
  // 3. INFRASTRUCTURE: a bad API key. Must NOT look like a revert.
  await attempt("infra: bad api key", () => badClient.call({ to: WETH, data: owner, blockNumber: BLOCK }));
  // 4. INFRASTRUCTURE: unreachable host. Must NOT look like a revert.
  await attempt("infra: unreachable host", () =>
    createPublicClient({ transport: http("http://127.0.0.1:1/") }).call({ to: WETH, data: owner, blockNumber: BLOCK }));
  // 5. INFRASTRUCTURE: a block far in the future (a non-archive-ish failure shape).
  await attempt("infra: absurd future block", () => client.call({ to: WETH, data: owner, blockNumber: 99999999999n }));
  const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const;
  const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const;
  const pause = encodeFunctionData({ abi: [{ type: "function", name: "pause", inputs: [], outputs: [], stateMutability: "nonpayable" }] });
  const renounceRole = encodeFunctionData({ abi: [{ type: "function", name: "renounceRole", inputs: [{type:"bytes32"},{type:"address"}], outputs: [], stateMutability: "nonpayable" }], args: ["0x0000000000000000000000000000000000000000000000000000000000000000","0x0000000000000000000000000000000000000000"] });
  // KNOWN EDGE #4: the documented no-revert-data case.
  await attempt("USDT.pause() from unrelated sender (edge #4: no revert data)",
    () => client.call({ to: USDT, data: pause, account: "0x000000000000000000000000000000000000dEaD", blockNumber: BLOCK }));
  // A CUSTOM ERROR revert (no Error(string)) — sUSDe's OperationNotAllowed shape.
  await attempt("sUSDe.renounceRole (custom error revert)",
    () => client.call({ to: SUSDE, data: renounceRole, account: "0x000000000000000000000000000000000000dEaD", blockNumber: BLOCK }));
  // A call into a plain EOA with garbage calldata: no code -> success, empty.
  await attempt("garbage selector on WETH9 (fallback revert, no data)",
    () => client.call({ to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", data: "0xdeadbeef", blockNumber: BLOCK }));
  // 6. Control: a call that succeeds.
  await attempt("control: USDC.owner() succeeds", () => client.call({ to: USDC, data: owner, blockNumber: BLOCK }));
  // 7. A call to an address with NO CODE: returns 0x, does not revert.
  await attempt("no code at address", () => client.call({ to: "0x000000000000000000000000000000000000dEaD", data: owner, blockNumber: BLOCK }));
}
main();
