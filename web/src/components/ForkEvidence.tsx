/**
 * The withdrawal differential, as three evidence blocks.
 *
 * This is the part a technical reviewer will read hardest, so the component's
 * job is to show what happened and refuse to imply anything more:
 *
 *  - NOTHING IS CLAIMED BEFORE THE OUTCOME ARRIVES. A block that has not run
 *    says so. It never shows a placeholder amount, a projected duration or a
 *    greyed-out result that reads as "about to be fine".
 *
 *  - A RECEIPT IS NOT AN EXIT, AND A REVERT IS NOT A CAUSE. The baseline is
 *    called established only when the engine verified the economics — assets
 *    actually received, principal cleared, no debt — not merely that the
 *    transaction succeeded. The re-exit is called a restriction only when the
 *    engine confirmed the expected revert cause AND unchanged balances AND
 *    matching times. Those judgements are made in `exitRestriction.ts`; this
 *    component renders them and adds none of its own.
 *
 *  - THE IMPERSONATION ASSUMPTION IS STATED NEXT TO THE RESULT, not in a
 *    footnote. anvil ignores signatures, so a Safe-guarded call demonstrates
 *    "this Safe can, if it authorises" — its own signature checks, transaction
 *    guards and modules did not execute. A reader who misses that would take
 *    the result for more than it is.
 */
import type { ForkTxView } from "@shared/dto";
import type { ForkBlockView } from "../useJob.js";
import type { ReactElement } from "react";

function TxList({ transactions }: { transactions: ForkTxView[] }): ReactElement | null {
  if (transactions.length === 0) return null;
  return (
    <details>
      <summary>Raw fork transactions ({transactions.length}) — receipts as the engine recorded them</summary>
      <div className="scroll-x">
        {transactions.map((tx, i) => (
          <div className="tx-row" key={i}>
            <div>
              <div className="tx-action">{tx.action}</div>
              <div className="tx-meta">
                from {tx.from}
                {tx.to && <> → {tx.to}</>}
                {tx.selector && <> · {tx.selector}</>}
              </div>
              {tx.revertData && <div className="tx-meta">revert data: {tx.revertData}</div>}
            </div>
            <div style={{ textAlign: "right" }}>
              <span className={`chip ${tx.status === "success" ? "good" : "crit"}`}>{tx.status}</span>
              <div className="tx-meta">
                gas {tx.gasUsed} · fork block {tx.localBlock} · t={tx.localTimestamp}
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="note small" style={{ marginBottom: 0, marginTop: 10 }}>
        These hashes are fork-local. They are not mainnet transaction hashes, and no mainnet transaction was sent.
      </p>
    </details>
  );
}

function Block({
  step,
  title,
  subtitle,
  view,
  pendingText,
}: {
  step: string;
  title: string;
  subtitle: string;
  view: ForkBlockView | null;
  pendingText: string;
}): ReactElement {
  return (
    <div className="evidence-block">
      <header>
        <span className="step">{step}</span>
        <h4>{title}</h4>
        {view && view.established === true && <span className="chip good">established</span>}
        {view && view.established === false && <span className="chip warn">not established</span>}
      </header>
      <p className="note" style={{ marginTop: 0 }}>
        {subtitle}
      </p>
      {view ? (
        <>
          <p className="statement" style={{ marginTop: 0 }}>
            {view.detail}
          </p>
          <TxList transactions={view.transactions} />
        </>
      ) : (
        <p className="muted small" style={{ marginBottom: 0 }}>
          {pendingText}
        </p>
      )}
    </div>
  );
}

export function ForkEvidence({
  fork,
  ceiling,
  sandboxNote,
  finished = false,
}: {
  fork: { baseline: ForkBlockView | null; mutation: ForkBlockView | null; reexit: ForkBlockView | null };
  ceiling?: string[];
  sandboxNote?: string;
  /**
   * Whether the run is over. It changes what an empty block SAYS: "not run yet"
   * is right while an analysis is in flight and wrong once it has finished —
   * on a completed run it reads as "about to happen", when in fact it never
   * will. Seen on WETH9, whose exit action could not be identified.
   */
  finished?: boolean;
}): ReactElement {
  const notRun = finished ? "Did not run. The reason is in the fork result above." : "Not run yet.";
  return (
    <section className="card">
      <h2>The withdrawal experiment</h2>
      <p className="note" style={{ marginTop: 0, maxWidth: "76ch" }}>
        Ripcord stops reasoning about whether an exit can be closed and tests it. A real withdrawal is established as a
        control, the party the engine found is impersonated and calls its restriction candidate, and the identical
        withdrawal is attempted again from the matching starting state at the same fork block and timestamp.
      </p>

      <Block
        step="A"
        title="Baseline withdrawal"
        subtitle="Fund a holder from a whale, supply into the protocol, then withdraw the full position. This must succeed before anything is mutated — without a control, no later failure can be attributed to anything."
        view={fork.baseline}
        pendingText={
          finished
            ? "Did not run, so no control exists. Nothing about this contract's exit is claimed from this experiment."
            : "Not run yet. Nothing is claimed about the exit until this succeeds."
        }
      />

      <Block
        step="B"
        title="Privileged mutation"
        subtitle="The guarding party the engine identified is impersonated and calls its restriction candidate with the exit-restricting argument. Other pause flags are preserved, so any change in the exit is attributable to this one flag."
        view={fork.mutation}
        pendingText={notRun}
      />

      <Block
        step="C"
        title="The same withdrawal, again"
        subtitle="The identical call, from the same starting balances and position, at the same fork block and timestamp as the control. Only the privileged mutation differs between the two branches."
        view={fork.reexit}
        pendingText={notRun}
      />

      {(fork.mutation || fork.reexit) && (
        <div className="banner info">
          <strong>The controller was impersonated on the fork.</strong> anvil ignores signatures, so where the guarding
          party is a Safe or a contract this shows that it <em>can</em> close the exit if it authorises the call. Its own
          signature checks, transaction guards and modules were not executed, and no notice its own process might impose
          was modelled.
        </div>
      )}

      {sandboxNote && (
        <p className="note small" style={{ marginBottom: 0 }}>
          {sandboxNote}
        </p>
      )}

      {ceiling && ceiling.length > 0 && (
        <div className="ceiling" style={{ marginTop: 12 }}>
          <strong>What this experiment does not establish</strong>
          <ul>
            {ceiling.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
