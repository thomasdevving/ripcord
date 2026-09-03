/**
 * The landing page: the thesis, one button to act on it, and one to read a
 * finished example.
 *
 * This screen used to be the form as well, under a rule that there must be no
 * marketing page in front of the tool. Splitting them keeps that rule rather
 * than abandoning it, because what was actually being protected was the
 * DISTANCE to a running analysis, not the presence of a form on the first
 * screen. That distance is now one click on the page's only primary control,
 * and in exchange the form is no longer squeezed to stay under a headline and
 * the headline is no longer squeezed to stay above a form.
 *
 * Nothing else was added. The page is a hero and one short section, and it ends.
 */
import { useEffect, useState } from "react";
import type { ConfigResponse } from "@shared/dto";
import { listReports } from "../api.js";
import { navigate } from "../router.js";
import { Hero } from "../components/Hero.js";
import type { ReactElement } from "react";

/** The contract the hero's example card quotes. See Hero.tsx. */
const QUOTED_ADDRESS = "0xc3d688b66703497daa19211eedff47f25384cdc3";

export function HomeScreen({ config }: { config: ConfigResponse | null }): ReactElement {
  const [sampleReportId, setSampleReportId] = useState<string | null>(null);

  /**
   * Resolve the hero's "See a Sample Report" target from the LISTING, never from
   * a hardcoded id.
   *
   * The listing contains only publishable reports, so a target found here is by
   * construction one the disclosure gate permits — a hardcoded id could point at
   * a report the gate blocks, and the link would hand out a 451 while looking
   * like an invitation. Preference goes to the report the example card quotes,
   * matched BY ADDRESS so a change to the id scheme cannot silently repoint the
   * link at a different protocol; any other calibration report is an acceptable
   * fallback. Nothing found means no link is rendered at all.
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

      <main className="container">
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
    </>
  );
}
