import { toFunctionSelector } from "viem";
for (const s of process.argv.slice(2)) console.log(toFunctionSelector(s), s);
