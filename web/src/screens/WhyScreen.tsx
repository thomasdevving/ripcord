/**
 * "Why Ripcord?" — the argument, stated once, so the rest of the interface does
 * not have to keep making it.
 *
 * THE WHOLE PAGE OBEYS THE SAME RULE AS A REPORT: capability, never intent. It
 * describes what privileged addresses are technically able to do, and never
 * suggests that anyone will. There is no scare copy here, no "rug", no
 * "malicious", and no unnamed protocol standing in for a villain — the figures
 * that appear are read from committed calibration reports, and the one place a
 * number is quoted, the address it belongs to is quoted with it.
 *
 * It also states the limits in the same voice as the claims. A page that argued
 * for the tool and buried what it cannot do would be making exactly the kind of
 * one-sided case the tool exists to replace.
 */
import { navigate } from "../router.js";
import type { ReactElement } from "react";

/**
 * What privileged power can do to a holder, in the categories Ripcord's own
 * taxonomy uses. Each is a CAPABILITY that legitimately exists in deployed
 * protocols today — the point is not that they are illegitimate, it is that
 * they are usually invisible to the person carrying the risk.
 */
const RISKS: { title: string; text: string }[] = [
  {
    title: "The code can be replaced",
    text:
      "Behind an upgradeable proxy, an admin can point the contract at a different implementation. The reviewed code and the running code are two different things, and nothing about the swap breaks a rule an audit checked.",
  },
  {
    title: "The exit can be closed",
    text:
      "A pause switch stops withdrawals for everyone; a per-account restriction stops them for one holder. Either way the question stops being how long leaving takes and becomes whether leaving is possible at all.",
  },
  {
    title: "Your share can be diluted",
    text:
      "Where a mint function is reachable by a privileged party, supply can change under a holder who did nothing. A timelock on the upgrade path says nothing about this one.",
  },
  {
    title: "The economics can be rewritten",
    text:
      "Fees, collateral factors, oracles and caps are ordinary parameters. Changing them changes what a position is worth without touching the code an auditor read.",
  },
];

/** What the tool does, in the order it does it. Deliberately mechanical. */
const DOES: { title: string; text: string }[] = [
  {
    title: "Resolves who actually holds power",
    text:
      "Proxy admin, owner, and role holders — then each contract holder is resolved into its own authority, up to three hops, until the path ends at an account, a multisig, or a timelock whose delay is read. Every path states why it stopped.",
  },
  {
    title: "Establishes what that power reaches",
    text:
      "Function selectors are recovered from the contract's own dispatcher and matched against a versioned table. Whether a privileged function is guarded is settled by real calls from unrelated addresses, not by reading names.",
  },
  {
    title: "Measures both clocks",
    text:
      "Notice before the rules can change, modelled per route and taken as the minimum, because the fastest route is the one that matters. Against that, how long leaving takes — as a floor, with the parts it could not measure named.",
  },
  {
    title: "Tests the exit instead of arguing about it",
    text:
      "Where the protocol is one it supports, Ripcord copies the chain into a sandbox, withdraws, has the privileged party close the exit, and withdraws again. A restriction is demonstrated by execution, not inferred from bytecode.",
  },
];

export function WhyScreen(): ReactElement {
  return (
    <main className="container home-content why-page">
      <header className="why-head">
        <p className="section-label">Why Ripcord</p>
        <h1>An audit asks whether the code is correct. It does not ask who can change it.</h1>
        <p className="why-lede">
          Both questions matter to anyone holding a position, and only one of them is routinely answered before they
          commit funds.
        </p>
      </header>

      <section className="home-answer" aria-labelledby="why-problem">
        <div>
          <p className="section-label">The problem</p>
          <h2 className="home-question" id="why-problem">
            The reviewed code is not necessarily tomorrow's code.
          </h2>
        </div>
        <div className="home-answer-copy">
          <p>
            An audit is a statement about a specific version of a contract at a specific time. Where that contract sits
            behind an upgradeable proxy, an admin can replace the implementation — or exercise any other legitimate
            on-chain power — without violating a single thing the audit checked. The report stays true and stops being
            the whole picture.
          </p>
          <p>
            None of this is hidden. The admin slot, the owner, the role holders, the delay on a timelock: all of it is
            public and readable in advance, by anyone, before they deposit. The gap is not secrecy. It is that nobody
            assembles it into an answer, so in practice the person carrying the risk does not have one.
          </p>
        </div>
      </section>

      <section className="home-limits" aria-labelledby="why-risks">
        <header className="home-section-heading">
          <p className="section-label">What is at stake</p>
          <h2 id="why-risks">What privileged power can do to a position</h2>
          <p>
            These capabilities exist in protocols that are working exactly as designed. Naming them is not an
            accusation — Ripcord never claims anyone will use one. The claim is only that they are reachable, and by
            whom.
          </p>
        </header>
        <ul className="limit-grid">
          {RISKS.map((risk) => (
            <li key={risk.title}>
              <strong>{risk.title}</strong>
              {risk.text}
            </li>
          ))}
        </ul>
      </section>

      <section className="home-answer" aria-labelledby="why-asymmetry">
        <div>
          <p className="section-label">The measurement</p>
          <h2 className="home-question" id="why-asymmetry">
            A delay only protects you if you can leave inside it.
          </h2>
        </div>
        <div className="home-answer-copy">
          <p>
            "This protocol has a 48-hour timelock" is only half a sentence. The half that decides whether you are
            protected is how long it takes <em>you</em> to get out — through a cooldown, an unbonding queue, a
            two-step withdrawal, or a pause that has already been flipped. If leaving takes at least as long as the
            notice, the notice buys you nothing.
          </p>
          <p>
            So Ripcord reports two figures and compares them: the notice before the rules can change, and the time
            needed to leave. Where either cannot be established, it says so instead of assuming the reassuring value —
            an unproven delay never appears as a window, and a zero never reads as an instant exit.
          </p>
          <div className="fork-sequence" aria-label="The comparison">
            <span>Notice before the rules change</span>
            <span aria-hidden="true">vs</span>
            <span>Time needed to leave</span>
          </div>
        </div>
      </section>

      <section className="home-method" aria-labelledby="why-does">
        <header className="home-section-heading">
          <p className="section-label">What it does</p>
          <h2 id="why-does">From a public chain to an answer</h2>
          <p>
            Every fact used is one anyone could read for themselves. The contribution is the assembly: authority
            analysis and bounded fork evidence in one pinned, reproducible report.
          </p>
        </header>
        <ol className="steps">
          {DOES.map((item, i) => (
            <li className="step" key={item.title}>
              <span className="step-n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
              <div className="step-body">
                <h4 className="step-title">{item.title}</h4>
                <p className="step-text">{item.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="home-answer" aria-labelledby="why-honest">
        <div>
          <p className="section-label">The honest part</p>
          <h2 className="home-question" id="why-honest">
            It will not tell you a contract is safe.
          </h2>
        </div>
        <div className="home-answer-copy">
          <p>
            No tool can. Proving that no path exists to restrict an exit — across every argument, every sequence, every
            market condition — is not something anyone can test. So Ripcord's strongest positive result is that no
            restriction was found among the paths it actually tried, carrying the count of what that was.
          </p>
          <p>
            The same discipline runs through everything else. A read that failed is recorded as unknown, never as an
            absence. An incomplete scan withholds the reassuring conclusions rather than rounding up to them. And where
            probing cannot rule out that a privileged function is unguarded, the report is withheld from publication
            rather than published as a vulnerability claim about a live contract.
          </p>
        </div>
      </section>

      <section className="why-cta">
        <h2>Read one, or run one.</h2>
        <p className="note">
          Every report is pinned to a block and reproducible. Nothing is signed, no wallet is connected, and no mainnet
          transaction is ever sent.
        </p>
        <div className="hb-actions">
          <button className="hb-btn" type="button" onClick={() => navigate({ name: "scan" })}>
            Scan an address
          </button>
          <button className="hb-link" type="button" onClick={() => navigate({ name: "saved" })}>
            Browse finished reports
          </button>
        </div>
      </section>
    </main>
  );
}
