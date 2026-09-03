import { formatTokenUnits } from "../report-types.js";
/**
 * The finished report.
 *
 * Continues the analysis page's visual structure rather than sending the reader
 * to a raw JSON dump: the report is the destination of the same story, not a
 * different artifact. JSON is one click away for anyone who wants it.
 *
 * THE RULES THIS COMPONENT ENFORCES BY RENDERING, not by commenting:
 *
 *  - NOTHING IS RECOMPUTED. Verdict, minimum notice, per-route notice and every
 *    uncertainty come from the server. The frontend does not take a minimum
 *    across routes, does not decide what is binding, and does not soften a
 *    status. A second implementation of that logic would eventually disagree
 *    with the first, and the one on screen is the one people believe.
 *
 *  - UNKNOWN NOTICE IS NOT ZERO. A route with no established notice renders as
 *    "not established", visually distinct from a route measured at 0s. Those
 *    mean opposite things: one is an open question, the other is a demonstrated
 *    absence of delay.
 *
 *  - A ZERO LOWER BOUND ON TIME-TO-EXIT IS NOT AN INSTANT EXIT. It means no
 *    duration was established. Rendering it as "0s — you can leave immediately"
 *    would invent the most reassuring possible reading of a missing measurement.
 *
 *  - AN UNDETERMINED VERDICT NEVER WEARS THE HEALTHY TONE. See `verdictTone`.
 */
import type { Report } from "../report-types.js";
import { formatDuration, verdictTone, VERDICT_GLOSS } from "../report-types.js";
import { CopyButton } from "./CopyButton.js";
import type { ReactElement } from "react";

function Routes({ report }: { report: Report }): ReactElement {
  const routes = report.exitWindow?.routes ?? [];
  if (routes.length === 0) {
    return (
      <p className="note">
        No authority route was recorded. That is a statement about what the search found, not a finding that none exists.
      </p>
    );
  }
  return (
    <>
      {routes.map((route, i) => {
        const notice = formatDuration(route.noticeSeconds);
        const nominal = formatDuration(route.nominalDelaySeconds);
        const tone =
          route.noticeStatus === "immediate" ? "immediate" : route.noticeStatus === "delayed" ? "delayed" : "unknown";
        return (
          <div className={`route ${tone}`} key={i}>
            <header>
              <span className="r-label">{route.label}</span>
              <span className="chip">{route.noticeStatus}</span>
              {route.confirmationMethod === "fork_confirmed" && <span className="chip crit">fork-confirmed</span>}
              <span className="r-notice">
                {/* An unproven delay shows its nominal value AND says it is
                    unproven. Showing the number alone would let a delay we
                    could not verify read as a settled window. */}
                {notice !== null
                  ? `notice ${notice}`
                  : nominal !== null
                    ? `nominal ${nominal} — NOT proven binding`
                    : "notice not established"}
              </span>
            </header>
            <div className="note small">
              {route.effectiveController ? (
                <>
                  resolves to <span className="addr">{route.effectiveController}</span> (
                  {route.effectiveControllerType ?? "type not established"}) · stopped: {route.terminationReason} ·
                  confidence {route.confidence}
                </>
              ) : (
                <>controller not resolved · stopped: {route.terminationReason}</>
              )}
            </div>
            {route.categories.length > 0 && (
              <div className="note small" style={{ marginTop: 4 }}>
                powers attributed here: {route.categories.join(", ")}
              </div>
            )}
            {route.note && (
              <details>
                <summary>Why this route reads the way it does</summary>
                <p className="note" style={{ margin: 0 }}>
                  {route.note}
                </p>
                {route.rolePrivilegeNote && (
                  <p className="note small" style={{ marginBottom: 0 }}>
                    Role privilege: {route.rolePrivilege} — {route.rolePrivilegeNote}
                  </p>
                )}
              </details>
            )}
          </div>
        );
      })}
      {report.exitWindow && report.exitWindow.routes.length > 0 && (
        <p className="note small">
          The protocol window is the <strong>minimum</strong> notice across these routes. A delay on one route does not
          protect another: a timelocked upgrade path says nothing about a pause reachable with no notice.
        </p>
      )}
    </>
  );
}

function Capabilities({ report }: { report: Report }): ReactElement {
  const caps = report.capabilities;
  const findings = caps.findings ?? [];
  return (
    <>
      <p className="note" style={{ marginTop: 0 }}>
        {caps.dispatcherRecognized
          ? `${caps.selectorsExtracted} function selector(s) recovered from the dispatcher: ${findings.length} classified, ${caps.needsManualVerification.length} needing manual verification, ${caps.unmatchedSelectors.length} unmatched.`
          : "The dispatcher's shape was not recognised, so the function surface could not be enumerated. Nothing below should be read as a complete list."}
      </p>
      {/* Coverage is stated before the findings on purpose: without it,
          "7 capabilities" reads as "there are only 7". Unmatched means "not in
          Ripcord's taxonomy", never "not privileged". */}
      {caps.unmatchedSelectors.length > 0 && (
        <div className="banner warn">
          {caps.unmatchedSelectors.length} recovered selector(s) are not in Ripcord's taxonomy and were not evaluated for
          privilege. Unmatched means unrecognised, not harmless — this list is not a complete account of what privileged
          functions exist.
        </div>
      )}
      {findings.length === 0 ? (
        <p className="note">No taxonomy-matched capability was attributed to a guard.</p>
      ) : (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>What it can do</th>
                <th>Category</th>
                <th>Guard</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((finding, i) => (
                <tr key={i}>
                  <td>{plainLanguage(finding.signature, finding.category)}</td>
                  <td>{finding.category}</td>
                  <td>
                    {finding.guard.status === "attributed" ? (
                      <>
                        <span className="chip crit">attributed</span>
                        <div className="addr" style={{ marginTop: 4 }}>
                          {finding.guard.holders.join(", ")}
                        </div>
                      </>
                    ) : (
                      <span className="chip warn">{finding.guard.status}</span>
                    )}
                  </td>
                  <td className="mono">
                    {finding.signature}
                    <div className="muted">{finding.selector}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {caps.needsManualVerification.length > 0 && (
        <details>
          <summary>{caps.needsManualVerification.length} function(s) needing manual verification</summary>
          <p className="note small">
            Probing could not place these behind a guard Ripcord recognises. That is not a claim they are unguarded — it
            is the absence of a recognised answer either way.
          </p>
          <ul className="plain">
            {caps.needsManualVerification.map((entry, i) => (
              <li key={i} className="mono">
                {entry.signature} — {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** A readable gloss for a signature. Falls back to the signature itself rather than inventing a description. */
function plainLanguage(signature: string, category: string): string {
  const name = signature.split("(")[0] ?? signature;
  const known: Record<string, string> = {
    upgradeTo: "Replace the contract's code",
    upgradeToAndCall: "Replace the contract's code and call into it",
    upgrade: "Replace the contract's code",
    pause: "Pause protocol operations",
    unpause: "Resume protocol operations",
    mint: "Create new tokens",
    burn: "Destroy tokens",
    transferOwnership: "Hand ownership to another address",
    blacklist: "Block an address from transacting",
    setCooldownDuration: "Change how long an exit takes",
  };
  if (known[name]) return known[name] as string;
  if (category === "CODE_CHANGE") return "Change the code that runs";
  if (category === "FUND_MOVEMENT") return "Move funds held by the contract";
  if (category === "ACCESS_RESTRICTION") return "Restrict who can act";
  if (category === "SUPPLY") return "Change token supply";
  if (category === "AUTHORITY_CHANGE") return "Change who holds authority";
  return name;
}

export function ReportView({
  report,
  reportId,
  forkEvidence,
}: {
  report: Report;
  reportId: string | null;
  /**
   * The three fork evidence blocks, rendered immediately after the fork RESULT
   * section rather than appended below Provenance. A slot rather than a sibling
   * because the evidence belongs with the conclusion it supports; putting it
   * after the provenance table made a reader scroll past the end of the report
   * to reach the thing the report is about.
   */
  forkEvidence?: ReactElement | null;
}): ReactElement {
  const verdict = report.verdict;
  const tone = verdictTone(verdict?.status);
  const tte = report.timeToExit;
  const er = report.exitRestriction;

  return (
    <>
      <section className={`card hero ${tone}`}>
        <div className="verdict-badge">{(verdict?.status ?? "no verdict").toUpperCase().replace(/_/g, " ")}</div>
        {verdict && <span className="chip" style={{ marginLeft: 10 }}>confidence: {verdict.confidence}</span>}
        <p className="statement">{verdict?.statement ?? "This report carries no verdict."}</p>
        {verdict && VERDICT_GLOSS[verdict.status] && (
          <p className="note" style={{ maxWidth: "76ch" }}>
            {VERDICT_GLOSS[verdict.status]}
          </p>
        )}
        {verdict && verdict.marginSeconds !== null && (
          <p className="note small">
            Margin between leaving and the rules changing: {formatDuration(verdict.marginSeconds) ?? `${verdict.marginSeconds}s`}.
          </p>
        )}
        {verdict && verdict.missing.length > 0 && (
          <div className="banner warn" style={{ marginTop: 12, marginBottom: 0 }}>
            <strong>Why this verdict is not crisper</strong>
            <ul className="plain" style={{ marginBottom: 0 }}>
              {verdict.missing.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Notice before the rules can change</h2>
        <Routes report={report} />
        {report.exitWindow && (
          <details>
            <summary>
              What was checked ({report.exitWindow.checksPerformed.filter((c) => c.performed).length} of{" "}
              {report.exitWindow.checksPerformed.length} checks performed)
            </summary>
            {/* This list is what makes an empty bypass list mean "checked, found
                none" rather than "never looked". */}
            <ul className="plain">
              {report.exitWindow.checksPerformed.map((check, i) => (
                <li key={i}>
                  <span className={`chip ${check.performed ? "" : "warn"}`}>{check.performed ? "performed" : "not performed"}</span>{" "}
                  {check.check} — {check.note}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="card">
        <h2>How long leaving takes</h2>
        {tte ? (
          <>
            <p className="statement" style={{ marginTop: 0 }}>
              {tte.statement}
            </p>
            <p className="note">
              {tte.atLeastSeconds === null ? (
                <strong>No exit duration was established.</strong>
              ) : (
                <>
                  <strong>
                    {tte.tight ? "" : "At least "}
                    {formatDuration(tte.atLeastSeconds)}
                  </strong>
                  {!tte.tight && " — a lower bound, with the unmeasured parts named below."}
                  {tte.atLeastSeconds === "0" && (
                    <>
                      {" "}
                      A zero lower bound means no waiting period was <em>detected</em>, not that leaving is instant.
                    </>
                  )}
                </>
              )}
            </p>
            {tte.legs.length > 0 && (
              <ul className="plain">
                {tte.legs.map((leg, i) => (
                  <li key={i}>
                    {leg.kind}: {leg.name} ={" "}
                    {leg.seconds === null ? <strong>duration unknown</strong> : formatDuration(leg.seconds)}
                    {leg.mutableBy && <> — settable via {leg.mutableBy}, so this is not a protocol constant</>}
                  </li>
                ))}
              </ul>
            )}
            {tte.unmeasuredLegs.length > 0 && (
              <div className="banner warn">
                <strong>Not measured, and therefore not counted as zero:</strong>
                <ul className="plain" style={{ marginBottom: 0 }}>
                  {tte.unmeasuredLegs.map((leg, i) => (
                    <li key={i}>
                      {leg.name} — {leg.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="note small">
              Liquidity depth is not modelled: {tte.liquidity.reason} For a position large relative to available
              liquidity, the real time to exit is longer than reported, never shorter.
            </p>
          </>
        ) : (
          <p className="note">No time-to-exit analysis was produced for this target.</p>
        )}
      </section>

      {er && (
        <section className="card">
          <h2>Fork experiment result</h2>
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="chip">{er.outcome.replace(/_/g, " ")}</span>
            <span className="chip">{er.restrictionState.replace(/_/g, " ")}</span>
            <span className={`chip ${er.confirmationMethod === "fork_confirmed" ? "crit" : "warn"}`}>
              {er.confirmationMethod.replace(/_/g, " ")}
            </span>
          </div>
          <table>
            <tbody>
              <tr>
                <th>Exit action</th>
                <td>
                  {er.exitAction.status === "identified" ? (
                    <>
                      <span className="mono">{er.exitAction.signature}</span> — {er.exitAction.note}
                    </>
                  ) : (
                    er.exitAction.note
                  )}
                </td>
              </tr>
              <tr>
                <th>Baseline</th>
                <td>
                  <span className={`chip ${er.baseline.status === "established" ? "good" : "warn"}`}>{er.baseline.status}</span>{" "}
                  {er.baseline.note}
                </td>
              </tr>
              <tr>
                <th>Coverage</th>
                <td>
                  {er.coverage.evaluated} of {er.coverage.guardedTotal} registered candidate(s) evaluated. This covers the
                  matched archetype's registered candidates, never every privileged function in the bytecode.
                </td>
              </tr>
            </tbody>
          </table>

          {er.candidates.length > 0 && (
            <>
              <h3>Candidates</h3>
              {er.candidates.map((candidate, i) => (
                <div className={`route ${candidate.result === "restrictor" ? "immediate" : "unknown"}`} key={i}>
                  <header>
                    <span className="r-label mono">{candidate.signature ?? candidate.selector}</span>
                    <span className={`chip ${candidate.result === "restrictor" ? "crit" : "warn"}`}>{candidate.result}</span>
                  </header>
                  <div className="note small">
                    called by <span className="addr">{candidate.guardingParty ?? "party not resolved"}</span>{" "}
                    ({candidate.guardingPartyType ?? "type not established"}) with {candidate.args}
                  </div>
                  <p className="note" style={{ marginBottom: 0 }}>
                    {candidate.detail}
                  </p>
                </div>
              ))}
            </>
          )}

          {er.evaluationGaps.length > 0 && (
            <div className="banner warn">
              <strong>Gaps that stop this evaluation concluding cleanly</strong>
              <ul className="plain" style={{ marginBottom: 0 }}>
                {er.evaluationGaps.map((gap, i) => (
                  <li key={i}>{gap}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="ceiling">
            <strong>What this experiment does not establish</strong>
            <ul>
              {er.ceiling.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
          <p className="note small">{er.sandboxNote}</p>
          {er.reproduceCommand && (
            <details>
              <summary>Reproduce this</summary>
              <pre className="raw">{er.reproduceCommand}</pre>
            </details>
          )}
        </section>
      )}

      {forkEvidence}

      {report.proof && (
        <section className="card">
          <h2>Upgrade drain proof</h2>
          {report.proof.produced ? (
            <>
              <p className="statement" style={{ marginTop: 0 }}>
                {report.proof.headline}
              </p>
              <p className="note">
                Impersonated via {report.proof.impersonatedVia}. Notice on this route:{" "}
                {report.proof.noticeSeconds === null ? "not established" : formatDuration(report.proof.noticeSeconds)} —{" "}
                {report.proof.noticeNote}
              </p>
              {report.proof.deltas.length > 0 && (
                <div className="scroll-x">
                  <table>
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Moved</th>
                        <th>USD</th>
                        <th>Price source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.proof.deltas.map((delta, i) => (
                        <tr key={i}>
                          <td>{delta.symbol}</td>
                          <td className="mono">{formatTokenUnits(delta.delta, delta.decimals)}<details><summary>Raw units</summary>{delta.delta}</details></td>
                          <td className="mono">{delta.usd === null ? "undetermined" : `$${delta.usd.toFixed(2)}`}</td>
                          <td className="small">{delta.priceSource}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="note small">
                Only curated major-token holdings are measured, so this figure is a floor, never a ceiling. {report.proof.sandboxNote}
              </p>
            </>
          ) : (
            <p className="note" style={{ marginTop: 0 }}>
              <strong>No proof was produced.</strong> {report.proof.failureReason} This is a statement about Ripcord's
              coverage, not a finding about the contract.
            </p>
          )}
        </section>
      )}

      <section className="card">
        <h2>Who holds power</h2>
        <Capabilities report={report} />
      </section>

      <section className="card">
        <h2>Coverage and uncertainty</h2>
        <div className="banner info">
          <strong>Enumeration:</strong>{" "}
          {report.enumeration.complete
            ? "every site the verdict rests on reported a complete scan."
            : "at least one site could not be fully enumerated. A reassuring window or verdict cannot be constructed over an incomplete route set, so the result stays cautious."}
        </div>
        {report.enumeration.gaps.length > 0 && (
          <ul className="plain">
            {report.enumeration.gaps.map((gap, i) => (
              <li key={i}>
                <span className="mono">{gap.where}</span> — {gap.reason}
              </li>
            ))}
          </ul>
        )}
        {report.unknowns.length > 0 && (
          <details>
            <summary>{report.unknowns.length} explicit unknown(s)</summary>
            <ul className="plain">
              {report.unknowns.map((unknown, i) => (
                <li key={i}>
                  <span className="mono">{unknown.field}</span> — {unknown.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        {report.errors.length > 0 && (
          <details>
            <summary>{report.errors.length} infrastructure error(s)</summary>
            <p className="note small">
              These are failures of our reads, not properties of the contract. A stage listed here fell back to a
              placeholder value and is never shown as a clean result.
            </p>
            <ul className="plain">
              {report.errors.map((error, i) => (
                <li key={i}>
                  <span className="mono">{error.stage}</span> — {error.message}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="card">
        <h2>Provenance</h2>
        <div className="scroll-x">
          <table>
            <tbody>
              <tr>
                <th>Target</th>
                <td className="mono">
                  {report.target.address} <CopyButton value={report.target.address} />
                </td>
              </tr>
              <tr>
                <th>Chain</th>
                <td>{report.chainId}</td>
              </tr>
              <tr>
                <th>Block</th>
                <td className="mono">
                  {report.block.number}
                  {report.block.hash && report.block.hash !== "0x" && <div className="muted">{report.block.hash}</div>}
                </td>
              </tr>
              <tr>
                <th>Analysis run at</th>
                {/* Distinct from the block's own time: one is when we looked,
                    the other is when the chain state existed. */}
                <td>{report.generatedAt}</td>
              </tr>
              <tr>
                <th>Ruleset / schema</th>
                <td className="mono">
                  ruleset {report.rulesetVersion} · schema {report.schemaVersion}
                </td>
              </tr>
              <tr>
                <th>Bytecode</th>
                <td className="mono">
                  {report.target.bytecodeSize} bytes
                  {report.target.bytecodeHash && <div className="muted">{report.target.bytecodeHash}</div>}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {reportId && (
          <div className="row" style={{ marginTop: 14 }}>
            <a className="btn shrink" href={`/api/reports/${encodeURIComponent(reportId)}/download`} download>
              Download JSON
            </a>
            <button className="shrink" type="button" onClick={() => window.print()}>
              Print / save as PDF
            </button>
            <CopyButton value={new URL(`/report/${reportId}`, window.location.origin).href} label="Copy link to this report" />
          </div>
        )}
      </section>
    </>
  );
}
