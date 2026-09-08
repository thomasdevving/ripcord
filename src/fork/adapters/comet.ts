/**
 * Compound III (Comet) base-asset supplier — the reference adapter.
 *
 * This is a behaviour-preserving port of the differential that was validated
 * live on cUSDCv3: the guardian named by `pauseGuardian()` (a 5-of-9 Safe) sets
 * `isWithdrawPaused = true`, and a baseline `withdraw` that recovered the full
 * base position before it then reverts with `Paused()`. Nothing about what is
 * checked has been relaxed by the move — the checks that used to sit inline in
 * the engine are the same checks, now owned by the protocol that understands
 * them.
 *
 * The exit hypothesis is deliberately not treated as proof of semantics: the
 * pinned Comet dispatcher does not expose its terminal withdraw branch in the
 * recovered selector set, so the fingerprint identifies a CANDIDATE interface
 * and the fork has to demonstrate real token recovery and a cleared position
 * before anything is called a baseline.
 */
import { encodeFunctionData, getAddress, maxUint256, type Hex } from "viem";
import type {
  AdapterContext,
  BaselineEvidenceSummary,
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

export const cometAbi = [
  { type: "function", name: "baseToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pauseGuardian", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "isWithdrawPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  ...["isSupplyPaused", "isTransferPaused", "isAbsorbPaused", "isBuyPaused"].map((name) => ({
    type: "function" as const, name, stateMutability: "view" as const, inputs: [], outputs: [{ type: "bool" as const }],
  })),
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "borrowBalanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "userBasic", stateMutability: "view", inputs: [{ type: "address" }], outputs: [
    { type: "int104" }, { type: "uint64" }, { type: "uint64" }, { type: "uint16" }, { type: "uint8" },
  ] },
  { type: "function", name: "supply", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  {
    type: "function", name: "pause", stateMutability: "nonpayable",
    inputs: [{ type: "bool" }, { type: "bool" }, { type: "bool" }, { type: "bool" }, { type: "bool" }], outputs: [],
  },
] as const;

/** Pinned selectors, each asserted against viem derivation from its signature in tests. */
export const COMET_SELECTORS = {
  supply: "0xf2b9fdb8" as Hex, // supply(address,uint256)
  withdraw: "0xf3fef3a3" as Hex, // withdraw(address,uint256)
  baseToken: "0xc55dae63" as Hex, // baseToken()
  isWithdrawPaused: "0x67800b5f" as Hex, // isWithdrawPaused()
  pauseGuardian: "0x24a3d622" as Hex, // pauseGuardian()
  pause: "0x44c35d07" as Hex, // pause(bool,bool,bool,bool,bool)
} as const;

/** Compound's own error selector for a paused action, asserted against derivation in tests. */
export const COMET_PAUSED_ERROR = "0x9e87fac8" as Hex; // Paused()

export function cometWithdrawPauseCalldata(otherFlags = { supply: false, transfer: false, absorb: false, buy: false }): Hex {
  return encodeFunctionData({ abi: cometAbi, functionName: "pause", args: [otherFlags.supply, otherFlags.transfer, true, otherFlags.absorb, otherFlags.buy] });
}
export function cometSupplyCalldata(baseToken: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: cometAbi, functionName: "supply", args: [baseToken, amount] });
}
export function cometWithdrawCalldata(baseToken: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: cometAbi, functionName: "withdraw", args: [baseToken, amount] });
}

const WITHDRAW_GAS = 900_000n;

interface CometPosition extends ExitObservation {
  tokens: bigint;
  supplied: bigint;
  borrowed: bigint;
  principal: bigint;
}

/** Receipt success alone cannot establish an exit. Require recovered assets, zero supply and no new debt. */
export function fullWithdrawalVerified(before: CometPosition, after: CometPosition): boolean {
  return before.supplied > 0n && before.principal > 0n && before.borrowed === 0n &&
    after.tokens - before.tokens >= before.supplied && after.principal === 0n &&
    after.supplied === 0n && after.borrowed === 0n;
}

export const cometAdapter: ExitProtocolAdapter = {
  id: "compound-comet-base",
  label: "Compound III (Comet) base-asset supplier",
  // An interface hypothesis, not proof of semantics — see the file header.
  fingerprint: [COMET_SELECTORS.supply, COMET_SELECTORS.baseToken, COMET_SELECTORS.isWithdrawPaused],
  exitSignature: "withdraw(address,uint256)",
  exitSelector: COMET_SELECTORS.withdraw,
  confidence: "high",
  archetype: "baseline exit vs. guarded restriction-family functions (Compound III / Comet base-withdrawal archetype)",
  coverageLimitations: [
    "Only the BASE asset withdrawal is covered here. Collateral withdrawal is a different path with its own guards, and it is examined — experimentally, and only as a sidecar that cannot change this verdict — by the asset-scenario layer.",
    "One pause candidate is registered: `pause(bool,bool,bool,bool,bool)` with withdraw-pause = true. Compound's other privileged functions, including supply caps, collateral factors and the governance-controlled configurator, were not exercised.",
  ],
  validatedOn: [1],
  supportsAssetScenarios: true,

  create(ctx: AdapterContext): ExitExperiment {
    let baseToken: Hex;
    let guardian: Hex;
    let decimals: number;
    let symbol: string;
    let whaleAddress: Hex;
    let otherFlags = { supply: false, transfer: false, absorb: false, buy: false };
    let fundAmount = 0n;
    let supplyAmount = 0n;

    const read = <T,>(functionName: string, phase: string, args?: readonly unknown[]) =>
      ctx.read<T>({ address: ctx.target, abi: cometAbi, functionName, ...(args ? { args } : {}), phase });

    const observe = async (phase: string): Promise<CometPosition> => {
      const head = await ctx.fork.client.getBlock();
      const at = <T,>(address: Hex, functionName: string) =>
        ctx.read<T>({ address, abi: cometAbi, functionName, args: [ctx.holder], phase });
      const tokens = await at<bigint>(baseToken, "balanceOf");
      const supplied = await at<bigint>(ctx.target, "balanceOf");
      const borrowed = await at<bigint>(ctx.target, "borrowBalanceOf");
      const basic = await at<readonly [bigint, bigint, bigint, number, number]>(ctx.target, "userBasic");
      return { tokens, supplied, borrowed, principal: basic[0], block: head.number, timestamp: head.timestamp };
    };

    return {
      async prepare(): Promise<AdapterRefusal | null> {
        baseToken = getAddress(await read<Hex>("baseToken", "identify"));
        guardian = getAddress(await read<Hex>("pauseGuardian", "identify"));
        const whale = whaleFor(ctx.chainId, baseToken);
        if (!whale) return refuse(`no curated whale for base token ${baseToken} on chain ${ctx.chainId}`);
        whaleAddress = whale.whale;
        decimals = whale.decimals;
        symbol = whale.symbol;
        fundAmount = 100_000n * 10n ** BigInt(decimals);
        supplyAmount = 50_000n * 10n ** BigInt(decimals);

        // A current pause is observable, but does not establish an exitable
        // position or a before/after causal witness. Do not fabricate a route.
        if (await read<boolean>("isWithdrawPaused", "before setup")) {
          return refuse("withdrawals are paused before setup; no successful baseline can be established, and no privileged mutation was tested");
        }
        otherFlags = {
          supply: await read<boolean>("isSupplyPaused", "before setup"),
          transfer: await read<boolean>("isTransferPaused", "before setup"),
          absorb: await read<boolean>("isAbsorbPaused", "before setup"),
          buy: await read<boolean>("isBuyPaused", "before setup"),
        };
        return null;
      },

      controlParty: () => guardian,

      async buildPosition(): Promise<AdapterRefusal | null> {
        const initial = await observe("before funding");
        if (initial.tokens !== 0n || initial.principal !== 0n || initial.supplied !== 0n || initial.borrowed !== 0n) {
          return refuse("the sandbox holder already has tokens or a protocol position; refusing to attribute pre-existing value to this setup");
        }
        await ctx.enable([whaleAddress, ctx.holder, guardian]);

        const fund = await ctx.send("fund holder", whaleAddress, {
          to: baseToken, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ctx.holder, fundAmount] }), gas: 200_000n,
        });
        if (fund.status !== "success") return refuse("funding the holder reverted");
        const funded = await observe("after funding");
        if (funded.tokens - initial.tokens !== fundAmount) return refuse("funding transaction succeeded but the expected base tokens were not received");

        const approve = await ctx.send("approve base token", ctx.holder, {
          to: baseToken, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ctx.target, fundAmount] }), gas: 100_000n,
        });
        if (approve.status !== "success") return refuse("base-token approval reverted");

        const supply = await ctx.send("supply baseline position", ctx.holder, {
          to: ctx.target, data: cometSupplyCalldata(baseToken, supplyAmount), gas: WITHDRAW_GAS,
        });
        if (supply.status !== "success") return refuse("supplying the baseline position reverted");
        const supplied = await observe("after supply");
        if (funded.tokens - supplied.tokens !== supplyAmount || supplied.principal <= 0n || supplied.supplied <= 0n || supplied.borrowed !== 0n) {
          return refuse("supply receipt succeeded but the expected token debit and positive debt-free base position were not established");
        }
        return null;
      },

      observe,

      async exit(phase: string): Promise<ExitAttempt> {
        const before = await observe(`before ${phase}`);
        const tx = await ctx.send(phase, ctx.holder, {
          to: ctx.target, data: cometWithdrawCalldata(baseToken, maxUint256), gas: WITHDRAW_GAS,
        });
        const after = await observe(`after ${phase}`);
        return { before, after, tx };
      },

      verifyFullExit: (attempt) =>
        attempt.tx.status === "success" && fullWithdrawalVerified(attempt.before as CometPosition, attempt.after as CometPosition),

      samePosition: (a, b) => {
        const x = a as CometPosition, y = b as CometPosition;
        return x.tokens === y.tokens && x.principal === y.principal && x.supplied === y.supplied && x.borrowed === y.borrowed;
      },

      baselineSummary(attempt) {
        const recovered = (attempt.after as CometPosition).tokens - (attempt.before as CometPosition).tokens;
        return {
          holderSource: `funded 100k ${symbol} from whale ${whaleAddress}, supplied 50k, then withdrew the full base position (uint256.max)`,
          note: `receipt success AND ${recovered} base-token units received, zero remaining principal, zero supply and zero debt; control and mutation use the same fork clock`,
          // The economic facts, not just the receipt: a successful receipt alone
          // is not an exit, which is why the recovered amount and the cleared
          // position are stated here rather than "withdraw succeeded".
          detail: `Baseline ESTABLISHED: the holder was funded 100k ${symbol}, supplied 50k, and withdrew the full base position — ${recovered} base-token units received back, zero remaining principal, zero supply, zero debt.`,
        };
      },

      candidates(): CandidateSpec[] {
        return [
          {
            selector: COMET_SELECTORS.pause,
            signature: "pause(bool,bool,bool,bool,bool)",
            category: "ACCESS_RESTRICTION",
            args: "withdraw-pause = true; other pause flags preserved",
            guardingParty: guardian,
            mutate: async () => {
              const before = await read<boolean>("isWithdrawPaused", "before candidate mutation");
              const tx = await ctx.send("guardian pause withdraw", guardian, {
                to: ctx.target, data: cometWithdrawPauseCalldata(otherFlags), gas: 300_000n,
              });
              if (tx.status !== "success") {
                return { executed: false, transitioned: false, detail: "the guardian mutation reverted; no effect on withdrawal was established" };
              }
              const after = await read<boolean>("isWithdrawPaused", "after candidate mutation");
              // The false→true transition is the mutation's whole content.
              // Without it there is no cause to attribute a later revert to.
              if (before || !after) {
                return { executed: true, transitioned: false, detail: `the call succeeded but the required isWithdrawPaused false→true transition was not observed (before=${before}, after=${after}), so no cause is established` };
              }
              return { executed: true, transitioned: true, detail: "called pause(bool,bool,bool,bool,bool) with withdraw-pause = true, other pause flags preserved. isWithdrawPaused observed false → true." };
            },
          },
        ];
      },

      judgeReexit({ baseline, attempt, gasLimit }): { result: RestrictionCandidate["result"]; detail: string } {
        const before = attempt.before as CometPosition;
        const after = attempt.after as CometPosition;
        const recovered = (baseline.after as CometPosition).tokens - (baseline.before as CometPosition).tokens;
        if (attempt.tx.status === "reverted") {
          if (
            attempt.tx.revertData?.toLowerCase() === COMET_PAUSED_ERROR.toLowerCase() &&
            attempt.tx.gasUsed < gasLimit &&
            after.tokens === before.tokens && after.principal === before.principal && after.borrowed === 0n
          ) {
            return {
              result: "restrictor",
              detail: "DIFFERENTIAL CONFIRMED: the control recovered the full base position; the guardian changed withdraw-pause from false to true, and the identical withdrawal at the same block/time reverted with Paused(), leaving the holder's tokens and principal unchanged.",
            };
          }
          return { result: "inconclusive", detail: "withdrawal reverted, but the expected Paused() cause and unchanged balances were not confirmed (an unrelated failure or gas limit is not a proven restrictor)" };
        }
        if (fullWithdrawalVerified(before, after) && after.tokens - before.tokens === recovered) {
          return { result: "no_effect", detail: "the pause transition executed, but the identical full withdrawal recovered the same base assets and cleared the position; no direct restriction in this evaluated scenario" };
        }
        return { result: "inconclusive", detail: "withdrawal receipt succeeded but recovery of the full base position did not match the control; no clean outcome is justified" };
      },
    };
  },
};
