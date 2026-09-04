/**
 * The landing page: the thesis, one button to act on it, and one to read a
 * finished example.
 *
 * This screen used to be the form as well, under a rule that there must be no
 * marketing page in front of the tool. Splitting them keeps that rule rather than
 * abandoning it, because what was being protected was the DISTANCE to a running
 * analysis, not the presence of a form on the first screen — that distance is now
 * one click on the page's only primary control.
 *
 * Below the hero, three editorial sections answer the obvious trust questions:
 * what the analysis asks, how it reaches an answer, and what it refuses to claim.
 */
import { useEffect, useState } from "react";
import type { ConfigResponse } from "@shared/dto";
import { listReports } from "../api.js";
import { navigate } from "../router.js";
import { Hero } from "../components/Hero.js";
import type { ReactElement } from "react";

/**
 * The pipeline, in the order it runs. Written from what the engine does, not
 * from what it is for: a reader deciding whether to trust an output wants the
 * mechanism, and every claim here is one the report itself carries evidence for.
 */
const STEPS: { title: string; text: string }[] = [
  {
    title: "Find who holds privileged power",
    text:
      "Proxy pattern first, because the code an auditor reviewed is not necessarily the code that runs tomorrow. Then owner and pending owner, then AccessControl roles — read from the enumerable getters where a contract has them, otherwise reconstructed by replaying grant and revoke events from the deployment block. A partial reconstruction is labelled partial, with the exact window it covered.",
  },
  {
    title: "Classify each holder",
    text:
      "Every address that turned up is resolved to an externally owned account, a multisig whose threshold and owners are read, or a contract. A threshold is recorded as a threshold — it raises how many parties must agree, and adds no notice at all.",
  },
  {
    title: "Establish what that power can do",
    text:
      "Function selectors are recovered from the contract's own dispatcher by following reachable jumps, not by scanning bytes, so code embedded for a child contract is not mistaken for this one's. Each is matched against a versioned table, and every selector recovered is either classified or listed as unmatched — never silently dropped.",
  },
  {
    title: "Attribute the guards by probing",
    text:
      "Whether a privileged function is actually guarded is settled with real calls at the pinned block, from three unrelated addresses, reading what comes back. A recognised authorization revert establishes that a guard fired; only where it also names a party already resolved is a holder attributed, and otherwise the finding says guarded, holder unknown. An unrecognised reply is never read as unguarded — and where the unguarded reading cannot be ruled out, the report is withheld from publication rather than shown, because 'guarded by a scheme we do not know' and 'not guarded' cannot be told apart from the outside.",
  },
  {
    title: "Follow authority to where it ends",
    text:
      "A contract that holds power is resolved into its own authority, and so on, to a depth of three. Every path terminates with a stated reason — an account, a multisig, a timelock whose delay is read, a cycle, or no authority found — and confidence falls as depth grows. An owner reached through three hops is never asserted with a direct owner's certainty.",
  },
  {
    title: "Measure both clocks, then test one",
    text:
      "Notice is modelled per route and the protocol's window is the minimum across them, since the fastest route is the one that matters. Time to exit is a lower bound with its unmeasured legs named. Where the fork experiment applies, a real withdrawal is established on a sandbox fork, the guarding party is made to close it, and the identical withdrawal is repeated — a restriction that is demonstrated rather than argued.",
  },
];

/** The contract the hero's example card quotes. See Hero.tsx. */
const QUOTED_ADDRESS = "0xc3d688b66703497daa19211eedff47f25384cdc3";

export function HomeScreen({ config }: { config: ConfigResponse | null }): ReactElement {
  const [sampleReportId, setSampleReportId] = useState<string | null>(null);

  /**
   * Resolve the hero's "See a Sample Report" target from the LISTING, never from
   * a hardcoded id. The listing contains only publishable reports, so a target
   * found here is by construction one the disclosure gate permits — a hardcoded
   * id could point at a blocked report and hand out a 451 while looking like an
   * invitation. Preference goes to the report the example card quotes, matched BY
   * ADDRESS so a change to the id scheme cannot silently repoint the link.
   * Nothing found means no link is rendered at all.
   */
  useEffect(() => {
    let cancelled = false;
    listReports()
      .then((res) => {
        if (cancelled) return;
        const quoted = res.reports.find((r) => r.address.toLowerCase() === QUOTED_ADDRESS);
        setSampleReportId((quoted ?? res.reports.find((r) => r.origin === "calibration"))?.id ?? null);
      })
      // A sample link is a convenience. Failing to resolve one is not worth a
      // banner on the first screen, and it must never affect starting a scan.
      .catch(() => {
        if (!cancelled) setSampleReportId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <Hero
        onScan={() => navigate({ name: "scan" })}
        onOpenSample={sampleReportId ? () => navigate({ name: "report", reportId: sampleReportId }) : null}
        liveDisabled={config ? !config.liveRuns.enabled : false}
        liveDisabledReason={config?.liveRuns.reason ?? null}
      />

      <main className="container home-content">
        <section className="home-answer" aria-labelledby="home-question">
          <div>
            <p className="section-label">The core question</p>
            <h2 className="home-question" id="home-question">
              Does an upgrade delay also protect your withdrawal?
            </h2>
          </div>
          <div className="home-answer-copy">
            <p>
              Those are two different routes. A timelock on the upgrade path says nothing about a pause function reachable
              with no notice at all. Ripcord reports them separately instead of letting the reassuring route stand in for
              the fastest one.
            </p>
            <div className="fork-sequence" aria-label="Fork experiment sequence">
              <span>Exit succeeds</span>
              <span aria-hidden="true">→</span>
              <span>Privilege executes</span>
              <span aria-hidden="true">→</span>
              <span>Same exit repeats</span>
            </div>
          </div>
        </section>

        {/* Numbered because this genuinely is a sequence: each step consumes what
            the one before it established, and the last two cannot run without the
            addresses the first three resolved. */}
        <section className="home-method" aria-labelledby="method-title">
          <header className="home-section-heading">
            <p className="section-label">The method</p>
            <h2 id="method-title">How a run works</h2>
            <p>
              Six stages, in order, pinned to one block so the complete run describes one moment onchain and can be
              repeated exactly.
            </p>
          </header>

          <ol className="steps">
            {STEPS.map((step, i) => (
              <li className="step" key={step.title}>
                <span className="step-n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                <div className="step-body">
                  <h4 className="step-title">{step.title}</h4>
                  <p className="step-text">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="home-limits" aria-labelledby="limits-title">
          <header className="home-section-heading">
            <p className="section-label">The boundaries</p>
            <h2 id="limits-title">What it will not tell you</h2>
            <p>The limits are part of the output, not a disclaimer underneath it.</p>
          </header>
          <ul className="limit-grid">
            <li>
              <strong>No safety verdict.</strong> The strongest positive result is that
              no restriction was found among the paths actually tested, carrying the count of what was tested.
            </li>
            <li>
              <strong>No prediction of intent.</strong> Findings describe what a privileged address is technically able to
              do. Intent is not observable on chain and is never claimed.
            </li>
            <li>
              <strong>No false absence.</strong> A read that failed is recorded as unknown, not as an
              absence. A delay that could not be proven binding never appears as a notice period.
            </li>
            <li>
              <strong>No liquidity promise.</strong> Market depth is not modelled, and the report says so as a
              field rather than a footnote. For a large position the real time to exit is longer than reported, never
              shorter.
            </li>
          </ul>
        </section>
      </main>
    </>
  );
}
