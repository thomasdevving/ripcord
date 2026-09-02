import { getAddress } from "viem";
for (const a of process.argv.slice(2)) console.log(getAddress(a));
