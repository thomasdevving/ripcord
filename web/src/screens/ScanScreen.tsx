/**
 * The scan form, on its own page. The home screen states the thesis and offers
 * one button; everything that configures a run lives here.
 *
 * THE BLOCK IS NOT A CHOICE. Every run measures the chain as it is when the
 * run is requested: the latest block is resolved ONCE, at submit, and then
 * pinned for every phase of the analysis — reads, fork, differential. That is
 * the important half and it is unchanged. What went away is the option to enter
 * a historical block, which mostly served the demo and made the first decision
 * on the form one that nobody arriving with an address wants to make.
 *
 * The consequence, stated rather than glossed: a run here is no longer directly
 * comparable to the committed calibration reports, which are pinned at block
 * 25,800,000. Those remain readable under Reports; they are simply a different
 * moment. The CLI still takes --block for anyone reproducing one of them.
 *
 * PRESETS CARRY NO EXPECTED RESULT — an address, a suggested mode and a reason
 * to look. Anything else shown before the run would be a claim the run has not
 * yet supported.
 *
 * WHAT TO RUN IS A LIST, NOT A DROPDOWN. The three modes differ in what they
 * actually DO — one reads, one forks, one forks twice — and each carries a
 * sentence saying so. A <select> hides two of three behind a click and gives
 * those sentences nowhere to live.
 */
import { useEffect, useRef, useState } from "react";
import { MOBULA_SECOND_LAYER_TARGET, type ConfigResponse, type RunMode } from "@shared/dto";
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

export function ScanScreen({ config }: { config: ConfigResponse | null }): ReactElement {
  const [address, setAddress] = useState("");
  const [mode, setMode] = useState<RunMode>("scan_withdrawal_test");
  const [refreshAssetContext, setRefreshAssetContext] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);

  const liveDisabled = config ? !config.liveRuns.enabled : true;
  const addressValid = ADDRESS_RE.test(address.trim());
  const canSubmit = !submitting && !liveDisabled && addressValid;
  const isMobulaTarget =
    address.trim().toLowerCase() === MOBULA_SECOND_LAYER_TARGET.address.toLowerCase();
  const mobulaSecondLayerAvailable = isMobulaTarget && mode !== "scan" && !liveDisabled;

  const availableModes = config?.availableModes ?? [];
  useEffect(() => {
    // Never leave a mode selected that this deployment cannot run — the user
    // would only find out when the job was refused.
    if (availableModes.length > 0 && !availableModes.includes(mode)) setMode(availableModes[0] as RunMode);
  }, [availableModes, mode]);

  useEffect(() => {
    // The server enforces the same restriction. Resetting here prevents a user
    // from selecting the second layer and then silently changing the request
    // into an unsupported address or a scan-only run.
    if (refreshAssetContext && !mobulaSecondLayerAvailable) setRefreshAssetContext(false);
  }, [refreshAssetContext, mobulaSecondLayerAvailable]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const fingerprint = JSON.stringify([
        address.trim().toLowerCase(), mode, refreshAssetContext,
      ]);
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
        // Resolved once by the server and pinned for the whole run; the worker,
        // the fork and the differential never see the string "latest".
        block: "latest",
        mode,
        refreshAssetContext,
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
    <main className="container scan-page">
      <section className="card">
        <p className="crumb">
          <button
            className="link"
            type="button"
            onClick={() => navigate({ name: "home" })}
          >
            ← Back
          </button>
        </p>

        <h1>Scan an address</h1>
        <p className="note" style={{ maxWidth: "70ch", marginTop: 0 }}>
          Ripcord reads who holds privileged power over a deployed contract, what that power lets them do, and how much
          notice exists before the rules can change. Then it tests, on a sandbox fork, whether a holder's exit can
          actually be closed. Every figure it reports comes from a read or a transaction it performed at a pinned block.
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
            ref={addressInputRef}
            className="mono"
            type="text"
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
            autoFocus
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
          <span className="label-text" id="mode-label">
            What to run
          </span>
          <div className="options" role="radiogroup" aria-labelledby="mode-label">
            {availableModes.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className="option"
                disabled={liveDisabled}
                onClick={() => setMode(m as RunMode)}
              >
                <span className="option-mark" aria-hidden="true" />
                <span className="option-body">
                  <span className="option-title">{MODE_LABELS[m].label}</span>
                  <span className="option-detail">{MODE_LABELS[m].detail}</span>
                </span>
              </button>
            ))}
          </div>
          {config && !config.anvil.available && (
            <div className="note small" style={{ marginTop: 8 }}>
              The fork sandbox is unavailable on this deployment, so the withdrawal experiment is not offered. A scan is
              unaffected.
            </div>
          )}
        </div>

        <div className="field asset-analysis-choice">
          <span className="label-text" id="asset-analysis-label">
            Analysis layer
          </span>
          <div className="options analysis-layer-options" role="radiogroup" aria-labelledby="asset-analysis-label">
            <button
              type="button"
              role="radio"
              aria-checked={!refreshAssetContext}
              className="option"
              disabled={liveDisabled || submitting}
              onClick={() => setRefreshAssetContext(false)}
            >
              <span className="option-mark" aria-hidden="true" />
              <span className="option-body">
                <span className="option-title">Ripcord analysis</span>
                <span className="option-detail">
                  Runs the selected pinned analysis and fork test. Nothing is sent to Mobula.
                </span>
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={refreshAssetContext}
              className="option"
              disabled={!mobulaSecondLayerAvailable || submitting}
              onClick={() => setRefreshAssetContext(true)}
            >
              <span className="option-mark" aria-hidden="true" />
              <span className="option-body">
                <span className="option-title">
                  Ripcord + Mobula 2nd layer <span className="chip warn">experimental</span>
                </span>
                <span className="option-detail">
                  After the core report, Mobula proposes asset candidates. Ripcord verifies them at the pinned block and
                  runs supported Compound III collateral withdrawals against the real pause function on a sandbox fork.
                </span>
              </span>
            </button>
          </div>
          {!isMobulaTarget && (
            <p className="note small analysis-layer-note">
              The second layer is currently available only for {MOBULA_SECOND_LAYER_TARGET.label}. Select its example
              below to enable it.
            </p>
          )}
          {isMobulaTarget && mode === "scan" && (
            <p className="note small analysis-layer-note">
              Choose a withdrawal-test mode above to enable the Mobula second-layer fork analysis.
            </p>
          )}
          {refreshAssetContext && (
            <p className="note small analysis-layer-consent">
              This explicitly shares the analysed contract address with Mobula after the core report completes. Mobula
              supplies context only and cannot change Ripcord's verdict. A confirmed restriction is demonstrated; an
              unconfirmed candidate is not evidence of safety.
            </p>
          )}
        </div>

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
                  if (availableModes.includes(preset.suggestedMode)) setMode(preset.suggestedMode);
                  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                  addressInputRef.current?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
                  addressInputRef.current?.focus({ preventScroll: true });
                }}
              >
                <strong>{preset.label}</strong>
                <span>{preset.note}</span>
                <span className="addr" style={{ display: "block", marginTop: 6 }}>
                  {preset.address}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
