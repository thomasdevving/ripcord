/**
 * Centre/Circle FiatToken holder — the SECOND adapter, and the one that proves
 * the abstraction is real rather than a rename of the Comet path.
 *
 * It was chosen because it is shaped as differently from Comet as anything in
 * scope. There is no protocol position to build and unwind: for a token holder,
 * "leaving" is `transfer`, the position is a balance, and the restriction is not
 * a global pause flag but a PER-ACCOUNT one — `blacklist(address)` aimed at the
 * holder. If the adapter contract can express both without the executor learning
 * anything about either, the split is doing its job. Where Comet needed an
 * approve and a supply, this needs neither; where Comet's restrictor is
 * protocol-wide, this one targets the exiting party by address.
 *
 * WHAT THIS IS AND IS NOT A CLAIM ABOUT. That a FiatToken blacklister can freeze
 * a holder is documented, intended design — `clearedRegistry.ts` records exactly
 * that for USDC, and the disclosure gate clears it as design-not-bug. Ripcord's
 * rule is capability, not intent: demonstrating that the capability EXISTS and
 * carries zero notice is a true statement about who holds power, and it is the
 * same statement Circle's own documentation makes. Nothing here says anyone
 * will use it.
 *
 * VALIDATION STATUS: the mechanics below are exercised against a live mainnet
 * fork in test/exitAdapters.live.test.ts, which is skipped unless
 * RIPCORD_RUN_LIVE_FORK_TESTS is set. Until that has been run on a chain, the
 * adapter's `validatedOn` list must not include it — the registry refuses to
 * produce a confident result for an unvalidated (chain, adapter) pair.
 */
import { decodeErrorResult, encodeFunctionData, getAddress, type Hex } from "viem";
import type {
  AdapterContext,
  AdapterRefusal,
  CandidateSpec,
  ExitAttempt,
  ExitExperiment,
  ExitObservation,
  ExitProtocolAdapter,
} from "./types.js";
import { refuse } from "./types.js";
import { erc20Abi, whaleFor } from "./funding.js";
import type { RestrictionCandidate } from "../../report/schema.js";

export const fiatTokenAbi = [
  ...erc20Abi,
  { type: "function", name: "blacklister", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "isBlacklisted", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "blacklist", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

/** Pinned selectors, asserted against viem derivation in tests. */
export const FIAT_TOKEN_SELECTORS = {
  blacklist: "0xf9f92be4" as Hex, // blacklist(address)
  unBlacklist: "0x1a895266" as Hex, // unBlacklist(address)
  isBlacklisted: "0xfe575a87" as Hex, // isBlacklisted(address)
  blacklister: "0xbd102430" as Hex, // blacklister()
  transfer: "0xa9059cbb" as Hex, // transfer(address,uint256)
} as const;

/**
 * FiatToken guards the transfer with
 * `require(!blacklisted[_account], "Blacklistable: account is blacklisted")`,
 * so the expected cause is a plain `Error(string)` carrying that message. Matched
 * on the DECODED string rather than on raw bytes: the message is stable across
 * the deployed FiatToken versions and the byte encoding is not worth pinning.
 */
const BLACKLIST_REVERT = "Blacklistable: account is blacklisted";

const errorStringAbi = [{ type: "error", name: "Error", inputs: [{ type: "string" }] }] as const;

function decodedRevertString(revertData: Hex | null | undefined): string | null {
  if (!revertData || revertData === "0x") return null;
  try {
    const decoded = decodeErrorResult({ abi: errorStringAbi, data: revertData });
    const [message] = decoded.args as readonly [string];
    return message;
  } catch {
    return null;
  }
}

const TRANSFER_GAS = 200_000n;

interface TokenPosition extends ExitObservation {
  holderTokens: bigint;
  sinkTokens: bigint;
}

export const fiatTokenAdapter: ExitProtocolAdapter = {
  id: "centre-fiat-token-holder",
  label: "Centre/Circle FiatToken holder",
  // All four are required. `transfer` alone is every ERC20 in existence; the
  // blacklist trio is what makes this specific administered-token shape.
  fingerprint: [
    FIAT_TOKEN_SELECTORS.transfer,
    FIAT_TOKEN_SELECTORS.blacklist,
    FIAT_TOKEN_SELECTORS.isBlacklisted,
    FIAT_TOKEN_SELECTORS.blacklister,
  ],
  exitSignature: "transfer(address,uint256)",
  exitSelector: FIAT_TOKEN_SELECTORS.transfer,
  confidence: "high",
  archetype: "baseline token transfer vs. a per-account freeze (Centre/Circle FiatToken blacklist archetype)",
  coverageLimitations: [
    "The exit tested is a plain token transfer to a neutral address. A holder whose real exit runs through a DEX, a bridge or a redemption flow faces those venues' own restrictions as well, none of which were exercised.",
    "One candidate is registered: `blacklist(address)` aimed at the exiting holder. The token's global `pause()`, its minter configuration and any upgrade path were not exercised here — the upgrade path is covered by the static authority analysis instead.",
    "A per-account freeze is demonstrated against the SANDBOX holder. That the same party can freeze any other specific address follows from the function's signature, not from this experiment.",
  ],
  validatedOn: [1],
  supportsAssetScenarios: false,

  create(ctx: AdapterContext): ExitExperiment {
    let blacklister: Hex;
    let whaleAddress: Hex;
    let decimals: number;
    let symbol: string;
    let fundAmount = 0n;

    const read = <T,>(functionName: string, phase: string, args?: readonly unknown[]) =>
      ctx.read<T>({ address: ctx.target, abi: fiatTokenAbi, functionName, ...(args ? { args } : {}), phase });

    const observe = async (phase: string): Promise<TokenPosition> => {
      const head = await ctx.fork.client.getBlock();
      const holderTokens = await read<bigint>("balanceOf", phase, [ctx.holder]);
      const sinkTokens = await read<bigint>("balanceOf", phase, [ctx.controlSink]);
      return { holderTokens, sinkTokens, block: head.number, timestamp: head.timestamp };
    };

    return {
      async prepare(): Promise<AdapterRefusal | null> {
        blacklister = getAddress(await read<Hex>("blacklister", "identify"));
        const whale = whaleFor(ctx.chainId, ctx.target);
        if (!whale) return refuse(`no curated whale for token ${ctx.target} on chain ${ctx.chainId}, so no holder can be funded to exit with`);
        whaleAddress = whale.whale;
        decimals = whale.decimals;
        symbol = whale.symbol;
        fundAmount = 100_000n * 10n ** BigInt(decimals);

        // Same rule as Comet's pre-existing pause: an already-frozen holder
        // yields no successful control, so there is no causal witness to build.
        if (await read<boolean>("isBlacklisted", "before setup", [ctx.holder])) {
          return refuse("the sandbox holder is already blacklisted before setup; no successful baseline transfer can be established");
        }
        if (await read<boolean>("isBlacklisted", "before setup", [whaleAddress])) {
          return refuse("the curated whale is blacklisted at this block, so it cannot fund the sandbox holder");
        }
        return null;
      },

      controlParty: () => blacklister,

      async buildPosition(): Promise<AdapterRefusal | null> {
        const initial = await observe("before funding");
        if (initial.holderTokens !== 0n || initial.sinkTokens !== 0n) {
          return refuse("the sandbox holder or the neutral recipient already holds this token; refusing to attribute pre-existing value to this setup");
        }
        await ctx.enable([whaleAddress, ctx.holder, blacklister]);
        const fund = await ctx.send("fund holder", whaleAddress, {
          to: ctx.target, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ctx.holder, fundAmount] }), gas: TRANSFER_GAS,
        });
        if (fund.status !== "success") return refuse("funding the holder reverted");
        const funded = await observe("after funding");
        if (funded.holderTokens - initial.holderTokens !== fundAmount) {
          return refuse("funding transaction succeeded but the expected tokens were not received");
        }
        return null;
      },

      observe,

      async exit(phase: string): Promise<ExitAttempt> {
        const before = await observe(`before ${phase}`);
        // The whole balance: a partial transfer would leave "could they have
        // moved the rest?" open, which is the question the exit is asking.
        const tx = await ctx.send(phase, ctx.holder, {
          to: ctx.target,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ctx.controlSink, (before as TokenPosition).holderTokens] }),
          gas: TRANSFER_GAS,
        });
        const after = await observe(`after ${phase}`);
        return { before, after, tx };
      },

      verifyFullExit: (attempt) => {
        const before = attempt.before as TokenPosition;
        const after = attempt.after as TokenPosition;
        // Receipt success is not an exit. The holder must be emptied AND the
        // recipient must have received exactly that amount — a token with a
        // transfer fee or a rebase would fail this, correctly.
        return attempt.tx.status === "success" && before.holderTokens > 0n &&
          after.holderTokens === 0n && after.sinkTokens - before.sinkTokens === before.holderTokens;
      },

      samePosition: (a, b) => {
        const x = a as TokenPosition, y = b as TokenPosition;
        return x.holderTokens === y.holderTokens && x.sinkTokens === y.sinkTokens;
      },

      baselineSummary(attempt) {
        const moved = (attempt.after as TokenPosition).sinkTokens - (attempt.before as TokenPosition).sinkTokens;
        return {
          holderSource: `funded 100k ${symbol} from whale ${whaleAddress}, then transferred the entire balance to a neutral recipient`,
          note: `receipt success AND ${moved} token units received by the neutral recipient with the holder's balance emptied to zero; control and mutation use the same fork clock`,
          detail: `Baseline ESTABLISHED: the holder was funded 100k ${symbol} and moved the entire balance out — ${moved} token units received by the neutral recipient, holder balance zero.`,
        };
      },

      candidates(): CandidateSpec[] {
        return [
          {
            selector: FIAT_TOKEN_SELECTORS.blacklist,
            signature: "blacklist(address)",
            category: "ACCESS_RESTRICTION",
            args: "the exiting holder's own address",
            guardingParty: blacklister,
            mutate: async () => {
              const before = await read<boolean>("isBlacklisted", "before candidate mutation", [ctx.holder]);
              const tx = await ctx.send("blacklister freezes holder", blacklister, {
                to: ctx.target, data: encodeFunctionData({ abi: fiatTokenAbi, functionName: "blacklist", args: [ctx.holder] }), gas: 200_000n,
              });
              if (tx.status !== "success") {
                return { executed: false, transitioned: false, detail: "the blacklister mutation reverted; no effect on the holder's exit was established" };
              }
              const after = await read<boolean>("isBlacklisted", "after candidate mutation", [ctx.holder]);
              if (before || !after) {
                return { executed: true, transitioned: false, detail: `the call succeeded but the required isBlacklisted false→true transition was not observed (before=${before}, after=${after}), so no cause is established` };
              }
              return { executed: true, transitioned: true, detail: "called blacklist(address) on the exiting holder. isBlacklisted(holder) observed false → true." };
            },
          },
        ];
      },

      judgeReexit({ attempt, gasLimit }): { result: RestrictionCandidate["result"]; detail: string } {
        const before = attempt.before as TokenPosition;
        const after = attempt.after as TokenPosition;
        if (attempt.tx.status === "reverted") {
          const message = decodedRevertString(attempt.tx.revertData);
          if (
            message === BLACKLIST_REVERT &&
            attempt.tx.gasUsed < gasLimit &&
            after.holderTokens === before.holderTokens && after.sinkTokens === before.sinkTokens
          ) {
            return {
              result: "restrictor",
              detail: `DIFFERENTIAL CONFIRMED: the control moved the holder's entire balance out; the blacklister then set isBlacklisted(holder) from false to true, and the identical transfer at the same block/time reverted with "${BLACKLIST_REVERT}", leaving the holder's balance untouched and unmovable.`,
            };
          }
          return { result: "inconclusive", detail: `transfer reverted, but the expected "${BLACKLIST_REVERT}" cause and unchanged balances were not confirmed (an unrelated failure or gas limit is not a proven restrictor)${message ? `; observed revert: "${message}"` : ""}` };
        }
        if (after.holderTokens === 0n && after.sinkTokens - before.sinkTokens === before.holderTokens) {
          return { result: "no_effect", detail: "the blacklist transition executed, but the identical transfer still moved the holder's entire balance out; no direct restriction in this evaluated scenario" };
        }
        return { result: "inconclusive", detail: "transfer receipt succeeded but the holder's balance did not move as the control did; no clean outcome is justified" };
      },
    };
  },
};
