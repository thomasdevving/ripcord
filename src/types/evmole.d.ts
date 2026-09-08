/**
 * EVMole 0.9.3 ships this API in dist/evmole.d.ts, but its package exports do
 * not currently associate that declaration file with the root Node export.
 * Keep this shim limited to the selector-only surface Ripcord consumes.
 */
declare module "evmole" {
  export interface ContractFunction {
    selector: string;
    bytecodeOffset: number;
    dispatch: "abi" | "fallback";
  }

  export interface ContractInfo {
    functions?: ContractFunction[];
  }

  export function contractInfo(
    code: string,
    args: { selectors?: boolean },
  ): ContractInfo;
}
