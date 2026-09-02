/**
 * Distinguishing-function identity check for calibration candidates that expose
 * no name()/symbol(). Reads a function only that specific contract would answer,
 * so an address goes into the calibration set on evidence, not on memory.
 */
import { createPublicClient, http, encodeFunctionData, parseAbi, type Hex } from "viem";
import { mainnet } from "viem/chains";

const PROBES: Record<string, string[]> = {
  "0x1F98431c8aD98523631AE4a59f267346ea31F984": ["owner()", "feeAmountTickSpacing(uint24)"],
  "0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B": ["comptrollerImplementation()", "admin()"],
  "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7": ["owner()", "A()"],
  "0xBA12222222228d8Ba445958a75a0704d566BF2C8": ["WETH()", "getAuthorizer()"],
  "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb": ["owner()", "feeRecipient()"],
  "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2": ["ADDRESSES_PROVIDER()", "POOL_REVISION()"],
  "0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5": ["owner()", "getLendingPool()"],
  "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2": ["symbol()", "owner()"],
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": ["wards(address)"],
  "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84": ["getTotalPooledEther()", "isStopped()"],
  "0xae78736Cd615f374D3085123A210448E74Fc6393": ["getExchangeRate()"],
  "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0": ["stETH()"],
  "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3": ["owner()", "minter()"],
  "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee": ["eETH()"],
  "0xac3E018457B222d93114458476f3E3416Abbe38F": ["asset()", "owner()"],
  "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD": ["asset()", "implementation()"],
  "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704": ["implementation()", "masterMinter()"],
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": ["admin()", "implementation()"],
  "0xdAC17F958D2ee523a2206206994597C13D831ec7": ["owner()", "getOwner()"],
  "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643": ["admin()", "underlying()"],
};

async function main() {
  process.loadEnvFile(".env");
  const client = createPublicClient({ chain: mainnet, transport: http(process.env.RPC_URL_1!) });
  const BLOCK = 25800000n;
  for (const [addr, sigs] of Object.entries(PROBES)) {
    const out: string[] = [];
    for (const sig of sigs) {
      const abi = parseAbi([`function ${sig} view returns (bytes32)`]);
      const args = sig.includes("(address)") ? ["0xBE8E3e3618f7474F8cB1d074A26afFef007E98FB"] : sig.includes("(uint24)") ? [3000] : [];
      try {
        const data = encodeFunctionData({ abi, functionName: sig.slice(0, sig.indexOf("(")) as never, args: args as never });
        const res = await client.call({ to: addr as Hex, data, blockNumber: BLOCK });
        out.push(`${sig}=${res.data ?? "0x"}`);
      } catch (e) {
        out.push(`${sig}=REVERT/absent`);
      }
    }
    console.log(addr, "|", out.join("  "));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
