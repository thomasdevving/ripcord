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

      {/* PLAIN LANGUAGE FIRST, PRECISION UNDERNEATH. The old opening named a
          "control withdrawal", a "candidate mutation" and "economic, state and
          timing checks" — every term exact, and the paragraph unreadable to
          anyone who did not already know what the experiment was. The three
          sentences below say what physically happens; the blocks that follow
          keep every original term, because the precise version is what a
          reviewer checks. */}
      <p className="statement" style={{ marginTop: 0, maxWidth: "76ch" }}>
        We copied the blockchain at the analysed block into a private sandbox, took money out the normal way, then had
        the party with the power to stop withdrawals do exactly that — and tried the identical withdrawal again.
      </p>
      <p className="note" style={{ maxWidth: "76ch" }}>
        If the first withdrawal works and the second one fails, that party can close the exit. This is a real sequence
        of executed transactions, not an argument about what the code appears to allow — and it happens in a throwaway
        copy of the chain. Nothing is sent to the real network, and nothing here says anyone intends to do it.
      </p>

      <ol className="fork-legend" aria-label="What each step below means">
        <li><span className="fork-legend-step">A</span> Money comes out, so we know the exit worked to begin with.</li>
        <li><span className="fork-legend-step">B</span> The privileged party makes its move.</li>
        <li><span className="fork-legend-step">C</span> The same withdrawal is attempted once more.</li>
      </ol>

      <details className="fold inline-fold">
        <summary>
          <span>What has to be true before we call it a restriction</span>
          <span className="fold-hint">why a failed second withdrawal is not enough on its own</span>
        </summary>
        <div className="fold-body">
          <p className="note" style={{ marginTop: 0 }}>
            A transaction that succeeds is not proof the money actually arrived, and a transaction that fails is not
            proof of the reason it failed. So step A counts only when the engine saw the assets received, the position
            cleared and no debt left behind — a receipt alone does not qualify. Step C counts only when it failed for
            the expected reason, from the same starting position, at a matching fork time.
          </p>
          <p className="note small" style={{ marginBottom: 0 }}>
            Those judgements are made in the engine (<span className="mono">src/fork/exitRestriction.ts</span>), not on
            this page. Reports produced under older rules keep the evidence and the limits they were generated with.
          </p>
        </div>
      </details>

      <Block
        step="A"
        title="Baseline withdrawal"
        subtitle="A normal withdrawal, before anyone interferes. It only counts if the assets genuinely came back — a successful receipt on its own does not demonstrate recovery of the full position."
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
        subtitle="The privileged party calls the function that restricts withdrawals, and we read the state back to confirm it actually changed. On its own this establishes nothing about the exit — a call can succeed and change nothing."
        view={fork.mutation}
        pendingText={notRun}
      />

      <Block
        step="C"
        title="The same withdrawal, again"
        subtitle="The identical withdrawal, attempted again. For this to mean the exit was closed, step A must have genuinely recovered the position, the starting state and fork time must match, and this failure must carry the expected cause."
        view={fork.reexit}
        pendingText={notRun}
      />

      {(fork.mutation || fork.reexit) && (
        <div className="banner info">
          <strong>We acted AS the privileged party, without its permission.</strong> The sandbox accepts any sender
          without a signature, so where that party is a multisig or a contract, this shows what it <em>can</em> do if it
          decides to — not that it agreed to. Its own signature threshold, transaction guards and modules were never
          executed, and any waiting period its internal process imposes is not modelled here. Whether the exit was
          actually closed is stated only by the recorded outcome above.
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
