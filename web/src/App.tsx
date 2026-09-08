/**
 * The shell: top bar, route switch, and the one-time config fetch everything
 * else depends on. `/api/config` carries whether live runs are possible at all
 * (and if not, why), which modes this deployment can execute, and the provider
 * host. Screens read those rather than guessing: offering a fork mode on a
 * deployment with no anvil, and only discovering it when the job fails, is worse
 * than not offering it.
 */
import { useEffect, useState } from "react";
import { applyTheme, readTheme, type Theme } from "./theme.js";
import type { ConfigResponse } from "@shared/dto";
import { getConfig } from "./api.js";
import { navigate, useRoute } from "./router.js";
import { HomeScreen } from "./screens/HomeScreen.js";
import { ScanScreen } from "./screens/ScanScreen.js";
import { AnalysisScreen } from "./screens/AnalysisScreen.js";
import { ReportScreen } from "./screens/ReportScreen.js";
import { SavedReportsScreen } from "./screens/SavedReportsScreen.js";
import type { ReactElement } from "react";

export function App(): ReactElement {
  const route = useRoute();
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  // Initialised from the same reader main.tsx already applied, so the control
  // reflects the document rather than a second opinion about it.
  const [theme, setTheme] = useState<Theme>(() => readTheme());
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
          <span className="brand-mark" aria-hidden="true">
            <img src="/ripcord-mark.png" alt="" />
          </span>
          <span className="brand-copy">
            <span className="brand-name">RIPCORD</span>
            <span className="brand-tagline">Privilege-path analyzer</span>
          </span>
        </a>
        <div className="topbar-spacer" />
        <nav className="topbar-nav" aria-label="Primary navigation">
          {/* A LINK INTO THE PAGE, not to a page of its own. The argument reads
              better as the first thing under the hero than as a destination
              someone has to decide to visit, so this scrolls rather than
              navigates — and still works from a report, by going home first
              and letting the section be found on the next frame. */}
          <a
            href="/#why"
            className="topbar-link"
            onClick={(e) => {
              e.preventDefault();
              if (route.name !== "home") navigate({ name: "home" });
              requestAnimationFrame(() =>
                document.getElementById("why")?.scrollIntoView({ behavior: "smooth", block: "start" }),
              );
            }}
          >
            Why Ripcord?
          </a>
          <a
            href="/scan"
            className={`topbar-link ${route.name === "scan" ? "active" : ""}`}
            aria-current={route.name === "scan" ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate({ name: "scan" });
            }}
          >
            New analysis
          </a>
          <a
            href="/saved"
            className={`topbar-link ${route.name === "saved" || route.name === "report" ? "active" : ""}`}
            aria-current={route.name === "saved" ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate({ name: "saved" });
            }}
          >
            Reports
          </a>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => {
              const next: Theme = theme === "dark" ? "light" : "dark";
              applyTheme(next);
              setTheme(next);
            }}
            // The control names the theme it SWITCHES TO, which is what a
            // reader is choosing; the icon shows the same thing.
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
          </button>
        </nav>
      </header>

      {configError && (
        <div className="container">
          <div className="banner warn">{configError}</div>
        </div>
      )}

      {route.name === "home" && <HomeScreen config={config} />}
      {route.name === "scan" && <ScanScreen config={config} />}
      {route.name === "analysis" && <AnalysisScreen key={route.jobId} jobId={route.jobId} />}
      {route.name === "report" && <ReportScreen key={route.reportId} reportId={route.reportId} />}
      {route.name === "saved" && <SavedReportsScreen />}
    </div>
  );
}
