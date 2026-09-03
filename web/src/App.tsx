/**
 * The shell: top bar, route switch, and the one-time config fetch everything
 * else depends on.
 *
 * `/api/config` is loaded once here and passed down. It carries whether live
 * runs are possible AT ALL (and if not, why), which modes this deployment can
 * execute, and the provider host. Screens read those rather than guessing:
 * offering a fork mode on a deployment with no anvil, and only discovering it
 * when the job fails, is a worse experience than not offering it.
 */
import { useEffect, useState } from "react";
import type { ConfigResponse } from "@shared/dto";
import { getConfig } from "./api.js";
import { navigate, useRoute } from "./router.js";
import { StartScreen } from "./screens/StartScreen.js";
import { AnalysisScreen } from "./screens/AnalysisScreen.js";
import { ReportScreen } from "./screens/ReportScreen.js";
import { SavedReportsScreen } from "./screens/SavedReportsScreen.js";
import type { ReactElement } from "react";

export function App(): ReactElement {
  const route = useRoute();
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch(() =>
        // The app still renders: saved reports do not need this call. Say what
        // is unavailable rather than showing an empty screen.
        setConfigError("The server configuration could not be loaded, so a new analysis cannot be started. Saved reports are unaffected."),
      );
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate({ name: "home" });
          }}
        >
          RIPCORD
          <span>Who holds power over a contract — and can you leave before they use it?</span>
        </a>
        <div className="topbar-spacer" />
        <a
          href="/saved"
          className="chip"
          onClick={(e) => {
            e.preventDefault();
            navigate({ name: "saved" });
          }}
        >
          Saved reports
        </a>
      </header>

      {configError && (
        <div className="container">
          <div className="banner warn">{configError}</div>
        </div>
      )}

      {route.name === "home" && <StartScreen config={config} />}
      {route.name === "analysis" && <AnalysisScreen jobId={route.jobId} />}
      {route.name === "report" && <ReportScreen reportId={route.reportId} />}
      {route.name === "saved" && <SavedReportsScreen />}
    </div>
  );
}
