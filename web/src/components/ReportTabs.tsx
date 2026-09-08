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

/**
 * One sentence per pane, shown under the strip.
 *
 * A tab label is a filing category, not an explanation — "Fork" and "Evidence"
 * tell a reader where something is kept, never what they are about to look at
 * or how much it is worth. These say what each pane holds and, where it
 * matters, what it does NOT establish: the fork line names the sandbox, and the
 * assets line says outright that an untested asset is a limit of the run rather
 * than a finding about the asset.
 */
export const TAB_INTRO: Record<FindingTab, string> = {
  overview:
    "The answer, and what the run established behind it. Every line links to the pane holding its evidence.",
  power:
    "Who can control this contract. Authority rises from the analysed address to the accounts, multisigs and timelocks that hold power over it — select any node to see the reads behind the relation and where the path stopped.",
  fork:
    "What happened when we actually tried it. The chain is copied into a private sandbox at this block, a withdrawal is performed, the party that can stop withdrawals does so, and the identical withdrawal is attempted again. Nothing is sent to the real network.",
  assets:
    "What this contract holds, and how far the evidence reaches for each asset — observed by the market-data provider, read on-chain at this block, or exercised in an experiment. An asset with no experiment is a limit of what this run tested, never a result about the asset.",
  evidence:
    "The raw material: every privileged function the dispatcher recovered, everything the run could not establish, and the provenance of the report itself — block, hashes and ruleset.",
};

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
