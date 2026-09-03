/**
 * The first screen IS the product.
 *
 * An address field and an Analyze button, above the fold, with two sentences of
 * context. No marketing page in front of the tool: the audience is a technical
 * reviewer with three minutes, and the fastest way to lose them is to make them
 * scroll past a value proposition to reach the thing that does the work.
 *
 * Two details that look cosmetic and are not:
 *
 *  - THE BLOCK IS ALWAYS VISIBLE, including when a preset filled it in. The
 *    Comet preset pins block 25,800,000, which is historical. An experiment run
 *    at a historical block is not a measurement of mainnet today, and a reader
 *    who does not notice which block they are on will draw a wrong conclusion
 *    from a correct result.
 *
 *  - PRESETS CARRY NO EXPECTED RESULT. They fill in an address, a block and a
 *    suggested mode, and a reason to look. No verdict, no party name, no figure.
 *    Anything shown next to a preset before the run would be a claim the run has
 *    not yet supported, and the first thing a reviewer checks is whether what
 *    appeared on screen actually came from the analysis.
 */
import { useEffect, useState } from "react";
import type { ConfigResponse, RunMode } from "@shared/dto";
import { createJob, ApiRequestError } from "../api.js";
import { navigate } from "../router.js";
import { rememberControlToken } from "../control.js";
import type { ReactElement } from "react";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const MODE_LABELS: Record<RunMode, { label: string; detail: string }> = {
  scan: {
    label: "Scan only",
    detail: "Static analysis at the pinned block. No fork, no simulation.",
  },
  scan_withdrawal_test: {
    label: "Scan + withdrawal test",
    detail:
      "The scan, then a fork experiment: establish a real withdrawal as a baseline, have the guarding party try to close it, and repeat the identical withdrawal.",
  },
  scan_withdrawal_test_upgrade_proof: {
    label: "Scan + withdrawal test + drain proof",
    detail:
      "Everything above, plus the upgrade-path drain proof. This is what the `ripcord restrict` command runs. Slower: it spawns a second fork.",
  },
};

export function StartScreen({ config }: { config: ConfigResponse | null }): ReactElement {
  const [address, setAddress] = useState("");
  const [mode, setMode] = useState<RunMode>("scan_withdrawal_test");
  const [blockMode, setBlockMode] = useState<"pinned" | "latest">("pinned");
  const [block, setBlock] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  useEffect(() => {
    if (config && block === "") setBlock(config.defaultBlock);
  }, [config, block]);

  const liveDisabled = config ? !config.liveRuns.enabled : true;
  const addressValid = ADDRESS_RE.test(address.trim());
  const blockValid = blockMode === "latest" || /^\d+$/.test(block.trim());
  const canSubmit = !submitting && !liveDisabled && addressValid && blockValid;

  const availableModes = config?.availableModes ?? [];
  useEffect(() => {
    // Never leave a mode selected that this deployment cannot run — the user
    // would only find out when the job was refused.
    if (availableModes.length > 0 && !availableModes.includes(mode)) setMode(availableModes[0] as RunMode);
  }, [availableModes, mode]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const fingerprint = JSON.stringify([address.trim().toLowerCase(), blockMode, block.trim(), mode]);
      let intent: { fingerprint: string; idempotencyKey: string; controlToken: string } | null = null;
      try { intent = JSON.parse(sessionStorage.getItem("ripcord-submit-intent") ?? "null"); } catch { /* no valid saved intent */ }
      if (intent?.fingerprint !== fingerprint) {
        intent = { fingerprint, idempotencyKey: crypto.randomUUID(), controlToken: crypto.randomUUID() + crypto.randomUUID() };
        sessionStorage.setItem("ripcord-submit-intent", JSON.stringify(intent));
      }
      const res = await createJob({
        idempotencyKey: intent.idempotencyKey,
        controlToken: intent.controlToken,
        address: address.trim(),
        chainId: 1,
        block: blockMode === "latest" ? "latest" : block.trim(),
        mode,
      });
      // Held in this tab only. It is the capability to cancel, and a job id
      // alone must not confer that — see docs/WEBAPP.md.
      if (res.controlToken) rememberControlToken(res.jobId, res.controlToken);
      sessionStorage.removeItem("ripcord-submit-intent");
      navigate({ name: "analysis", jobId: res.jobId });
    } catch (err) {
      if (err instanceof ApiRequestError) setError({ message: err.api.message, hint: err.api.hint });
      else setError({ message: "The analysis could not be started.", hint: "Check your connection and try again." });
      setSubmitting(false);
    }
  };

  return (
    <main className="container">
      <section className="card">
        <h1>Analyze a contract</h1>
        <p className="note" style={{ maxWidth: "70ch", marginTop: 0 }}>
          Ripcord reads who holds privileged power over a deployed contract, what that power lets them do, and how much
          notice exists before the rules can change. Then it tests, on a sandbox fork, whether a holder's exit can
          actually be closed. Every figure below comes from a read or a transaction it performed at a pinned block.
        </p>

        {config && liveDisabled && (
          <div className="banner warn">
            <strong>Analyze is unavailable.</strong> {config.liveRuns.reason}
          </div>
        )}

        <div className="field">
          <label htmlFor="addr">Contract address — Ethereum Mainnet</label>
          <input
            id="addr"
            className="mono"
            type="text"
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) void submit();
            }}
            aria-invalid={address.length > 0 && !addressValid}
            aria-describedby="addr-help"
          />
          <div id="addr-help" className="note small" style={{ marginTop: 5 }}>
            {address.length > 0 && !addressValid
              ? "That is not a valid address — 0x followed by 40 hexadecimal characters."
              : "No wallet connection is needed. Ripcord signs nothing and sends no mainnet transaction."}
          </div>
        </div>

        <div className="field">
          <label htmlFor="mode">What to run</label>
          <select id="mode" value={mode} onChange={(e) => setMode(e.target.value as RunMode)} disabled={liveDisabled}>
            {availableModes.map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m].label}
              </option>
            ))}
          </select>
          <div className="note small" style={{ marginTop: 5 }}>
            {MODE_LABELS[mode].detail}
          </div>
          {config && !config.anvil.available && (
            <div className="note small" style={{ marginTop: 5 }}>
              The fork sandbox is unavailable on this deployment, so the withdrawal experiment is not offered. A scan is
              unaffected.
            </div>
          )}
        </div>

        {/* The pinned block is stated OUTSIDE the advanced section on purpose:
            it changes what the result means, so it must never be something the
            reader has to go looking for. */}
        <div className="banner info" style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap" }}>
          <span>
            <strong>Pinned block:</strong>{" "}
            <span className="mono">{blockMode === "latest" ? "resolved once at start, then fixed" : block || "—"}</span>
          </span>
          {blockMode === "pinned" && config && block === config.defaultBlock && (
            <span className="muted small">
              This is a historical block. The result describes the chain at that block, not mainnet right now.
            </span>
          )}
          <button className="link small" type="button" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
            {advanced ? "Hide advanced" : "Change block"}
          </button>
        </div>

        {advanced && (
          <div className="card" style={{ marginBottom: 14, background: "var(--plane)" }}>
            <h3>Advanced</h3>
            <div className="row">
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="blockmode">Block selection</label>
                <select id="blockmode" value={blockMode} onChange={(e) => setBlockMode(e.target.value as "pinned" | "latest")}>
                  <option value="pinned">Specific block number</option>
                  <option value="latest">Latest block (resolved once, then pinned)</option>
                </select>
              </div>
              {blockMode === "pinned" && (
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="block">Block number</label>
                  <input
                    id="block"
                    className="mono"
                    type="text"
                    inputMode="numeric"
                    value={block}
                    onChange={(e) => setBlock(e.target.value)}
                    aria-invalid={!blockValid}
                  />
                </div>
              )}
            </div>
            <p className="note small" style={{ marginBottom: 0, marginTop: 10 }}>
              Every phase of the run uses the same chain, the same block number and the same block identity. "Latest" is
              resolved once at the start and then fixed, so a multi-minute analysis cannot drift across blocks.
            </p>
          </div>
        )}

        {error && (
          <div className="banner danger">
            <strong>{error.message}</strong>
            {error.hint && <div style={{ marginTop: 4 }}>{error.hint}</div>}
          </div>
        )}

        <div className="row" style={{ marginTop: 4 }}>
          <button className="primary shrink" type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {submitting ? "Starting…" : "Analyze contract"}
          </button>
          {config && (
            <span className="note small" style={{ flex: 1 }}>
              {config.limits.maxActiveJobs} analysis at a time, up to {config.limits.maxQueuedJobs} queued.
              {config.providerHost && <> Reading via {config.providerHost}.</>}
            </span>
          )}
        </div>
      </section>

      {config && config.presets.length > 0 && (
        <section className="card">
          <h3>Start from an example</h3>
          <p className="note" style={{ marginTop: 0 }}>
            These fill the form in. They carry no expected outcome — whatever appears on the next screen comes from the
            run you are about to start.
          </p>
          <div className="grid-2">
            {config.presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="preset-btn"
                onClick={() => {
                  setAddress(preset.address);
                  setBlock(preset.block);
                  setBlockMode("pinned");
                  if (availableModes.includes(preset.suggestedMode)) setMode(preset.suggestedMode);
                }}
              >
                <strong>{preset.label}</strong>
                <span>{preset.note}</span>
                <span className="addr" style={{ display: "block", marginTop: 6 }}>
                  {preset.address} · block {preset.block}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h3>What the analysis answers</h3>
        <p className="statement" style={{ marginTop: 0, maxWidth: "68ch" }}>
          Does an upgrade delay also protect your withdrawal?
        </p>
        <p className="note" style={{ maxWidth: "70ch" }}>
          Those are two different routes. A timelock on the upgrade path says nothing about a pause function reachable
          with no notice at all, and Ripcord reports them separately rather than letting the reassuring one stand in for
          the other. Where the fork experiment runs, the answer comes from a withdrawal that succeeded, a privileged
          call, and the same withdrawal attempted again.
        </p>
      </section>
    </main>
  );
}
