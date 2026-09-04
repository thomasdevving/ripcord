/**
 * The withdrawal differential, as three evidence blocks. A technical reviewer
 * will read this hardest, so the component shows what happened and refuses to
 * imply anything more:
 *
 *  - NOTHING IS CLAIMED BEFORE THE OUTCOME ARRIVES. A block that has not run
 *    says so — never a placeholder amount or a greyed-out result that reads as
 *    "about to be fine".
 *  - A RECEIPT IS NOT AN EXIT, AND A REVERT IS NOT A CAUSE. The baseline is
 *    established only when the engine verified the economics (assets received,
 *    principal cleared, no debt), and the re-exit is a restriction only when the
 *    engine confirmed the expected revert cause AND unchanged balances AND
 *    matching times. Those judgements live in `exitRestriction.ts`.
 *  - THE IMPERSONATION ASSUMPTION IS STATED NEXT TO THE RESULT, not in a
 *    footnote: anvil ignores signatures, so a Safe-guarded call demonstrates
 *    "this Safe can, if it authorises".
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
              {tx.transactionHash && <div className="tx-meta">fork tx: {tx.transactionHash}</div>}
              {tx.calldata && <div className="tx-meta">calldata: {tx.calldata}</div>}
              {tx.revertData && <div className="tx-meta">revert data: {tx.revertData}</div>}
            </div>
            <div style={{ textAlign: "right" }}>
              <span className={`chip ${tx.status === "success" ? "good" : "crit"}`}>{tx.status}</span>
              <div className="tx-meta">
                gas {tx.gasUsed || "unavailable"} · fork block {tx.localBlock || "unavailable"} · t={tx.localTimestamp || "unavailable"}
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
        <span className="evidence-step">{step}</span>
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
          {view.legacy && <div className="banner warn">Legacy evidence — do not read this as a full-position economic proof under the current rules.</div>}
          <TxList transactions={view.transactions} />
          {view.evidence && view.evidence.length > 0 && <details><summary>Exact reads, balances and position evidence (raw units)</summary>
            <div className="scroll-x"><table><thead><tr><th>Phase / action</th><th>Read</th><th>Raw value</th><th>Fork block / time</th></tr></thead><tbody>
              {view.evidence.map((entry, i) => { const e = entry as { params?: Record<string, unknown>; rawValue?: unknown }; const p = e.params ?? {};
                if (p.method === "eth_sendTransaction") return null;
                return <tr key={i}><td>{String(p.phase ?? p.action ?? "—")}</td><td className="mono">{String(p.read ?? p.method ?? "read")}</td><td className="mono">{JSON.stringify(e.rawValue)}</td><td>{String(p.localBlock ?? "unavailable")} / {String(p.localTimestamp ?? "unavailable")}</td></tr>;
              })}
            </tbody></table></div>
            <pre>{JSON.stringify(view.evidence, null, 2)}</pre>
          </details>}
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
  const notRun = finished ? "No separate evidence for this step is available. See the recorded outcome and limitations." : "Waiting for recorded evidence.";
  return (
    <section className="card">
      <h2>The withdrawal experiment</h2>
      <p className="note" style={{ marginTop: 0, maxWidth: "76ch" }}>
        The experiment compares a control withdrawal with a withdrawal after a candidate mutation.
        The recorded outcome states which economic, state and timing checks actually passed.
        Older reports retain their original evidence and limitations.
      </p>

      <Block
        step="A"
        title="Baseline withdrawal"
        subtitle="Recorded setup and control withdrawal. A successful receipt alone does not demonstrate recovery of the full position."
        view={fork.baseline}
        pendingText={
          finished
            ? "No baseline evidence is available. Nothing about this contract's exit is claimed from an absent control."
            : "Not run yet. Nothing is claimed about the exit until this succeeds."
        }
      />

      <Block
        step="B"
        title="Privileged mutation"
        subtitle="The candidate call and observed state change. This step alone does not establish that an exit was closed."
        view={fork.mutation}
        pendingText={notRun}
      />

      <Block
        step="C"
        title="The same withdrawal, again"
        subtitle="Recorded withdrawal after the candidate. Causality requires matching starting positions and times, verified economic recovery in A, and the expected cause of failure in C."
        view={fork.reexit}
        pendingText={notRun}
      />

      {(fork.mutation || fork.reexit) && (
        <div className="banner info">
          <strong>The controller was impersonated on the fork.</strong> anvil ignores signatures, so where the guarding
          party is a Safe or a contract, execution assumes that it can authorise the attempted call. Whether the exit
          was restricted is stated only by the recorded differential outcome. Its own
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
