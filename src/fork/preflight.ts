/**
 * Preflight check for the day-3 Proof Engine's only external dependency:
 * the `anvil` binary from Foundry.
 *
 * Ripcord drives anvil from TypeScript via viem's test client — no forge, no
 * Solidity test contracts, no Hardhat. That keeps the whole codebase in one
 * language and one toolchain, and it means the only thing that has to exist
 * on the machine is a single binary.
 *
 * This fails LOUD and early with install instructions rather than letting a
 * fork simulation die halfway through with an opaque connection error. Same
 * "fail loud" rule the chain layer follows: a missing dependency is not an
 * empty result.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class AnvilUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `anvil is required for fork simulation but is not usable: ${cause}\n\n` +
        `Install Foundry, then re-run:\n` +
        `  curl -L https://foundry.paradigm.xyz | bash\n` +
        `  foundryup\n\n` +
        `If it is already installed, make sure ~/.foundry/bin is on your PATH.`,
    );
    this.name = "AnvilUnavailableError";
  }
}

export interface AnvilInfo {
  available: true;
  version: string;
}

/**
 * Returns anvil's version, or throws AnvilUnavailableError. Never returns a
 * "probably fine" default — the caller either has a working binary or gets a
 * message telling them exactly how to fix it.
 */
export async function checkAnvilAvailable(): Promise<AnvilInfo> {
  try {
    const { stdout } = await execFileAsync("anvil", ["--version"], { timeout: 10_000 });
    const version = stdout.trim().split("\n")[0] ?? stdout.trim();
    if (!version) throw new AnvilUnavailableError("`anvil --version` produced no output");
    return { available: true, version };
  } catch (err) {
    if (err instanceof AnvilUnavailableError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new AnvilUnavailableError("not found on PATH");
    throw new AnvilUnavailableError(err instanceof Error ? err.message : String(err));
  }
}
