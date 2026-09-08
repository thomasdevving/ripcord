/**
 * The report's panes.
 *
 * WHY TABS AT ALL: the report is one argument made of several kinds of
 * evidence, and a single scroll made a reader hunt for the part that mattered.
 * Splitting it lets the overview list link straight at the pane holding the
 * proof for a line the reader just read.
 *
 * A TAB IS NEVER HIDDEN BECAUSE IT IS EMPTY OF FINDINGS — only because the run
 * produced no such artifact at all (no fork was run, no asset snapshot was
 * stored). The distinction matters for the same reason it does everywhere else
 * in this project: a pane that exists and shows nothing is a checked-and-found-
 * nothing result; a pane that was never populated must not masquerade as one,
 * so it is absent rather than empty.
 *
 * Real tab semantics, not styled links: arrow keys move between tabs, the
 * panels are labelled by their tab, and the whole strip is one tab stop.
 */
import type { FindingTab } from "@shared/findings";
import type { ReactElement } from "react";

export interface TabDef {
  id: FindingTab;
  label: string;
}

export function ReportTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: TabDef[];
  active: FindingTab;
  onSelect: (tab: FindingTab) => void;
}): ReactElement | null {
  if (tabs.length < 2) return null;

  const move = (delta: number) => {
    const index = tabs.findIndex((tab) => tab.id === active);
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next) {
      onSelect(next.id);
      document.getElementById(`tab-${next.id}`)?.focus();
    }
  };

  return (
    <div className="report-tabs" role="tablist" aria-label="Report sections">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={`tab-${tab.id}`}
          type="button"
          role="tab"
          className={`report-tab ${tab.id === active ? "active" : ""}`}
          aria-selected={tab.id === active}
          aria-controls={`panel-${tab.id}`}
          tabIndex={tab.id === active ? 0 : -1}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
            if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
