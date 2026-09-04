import { publicValue } from "./sanitize.js";
/**
 * THE READ SIDE OF REPORTS, and the single place the publication gate is
 * enforced for every outward transport.
 *
 * `disclosure.publishable` is not advice. It is false when Ripcord probed a
 * privileged-looking function and could not attribute it to a recognised guard —
 * which means the "this live contract may be unguarded" reading could not be
 * ruled out. Shipping that report to a browser would publish a vulnerability
 * claim about a real contract, whatever the UI then chose to render.
 *
 * So the gate lives HERE, once, in the function that loads a report, rather than
 * in each route. Three consequences, all deliberate:
 *
 *  - HTML, JSON and download all go through `loadPublishable`. There is no
 *    second path to a report body.
 *  - A blocked report is never serialised toward the client "to be hidden in the
 *    UI". The bytes do not leave the process. Hiding with CSS is not withholding.
 *  - The refusal is NEUTRAL. It names no signature, no selector and no address
 *    beyond the one the caller already asked about, because the refusal message
 *    is itself published, and a message describing what was blocked would leak
 *    the very thing the gate exists to hold back.
 *
 * Committed calibration reports are served alongside live ones, from an explicit
 * ALLOWLIST built at startup by reading each file and checking the same gate —
 * never by exposing `calibration/` as a directory. A filesystem served by prefix
 * is one traversal bug away from serving the RPC cache and the job store that
 * sit beside it.
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { SavedReportListItem } from "./shared/dto.js";
import { JobStore, isSafeId } from "./jobs/store.js";
import type { AssetContextArtifact } from "./asset-context.js";

export interface ReportSource {
  id: string;
  origin: "live" | "calibration";
  publishable: boolean;
}

/** A report body plus the metadata a page needs to state its provenance. */
export interface LoadedReport {
  id: string;
  origin: "live" | "calibration";
  report: unknown;
}

export class ReportService {
  /** id → absolute path, for committed calibration reports only. Built once at startup. */
  private readonly calibration = new Map<string, { path: string; item: SavedReportListItem }>();

  /**
   * Mobula snapshots, indexed by `<chainRef>|<lowercased target>` — never by
   * file name or protocol name.
   *
   * Keying on the address is what lets a FRESH scan of a target reuse the
   * committed snapshot for that same address: it is the same account, and the
   * snapshot keeps its original `fetchedAt`, which the panel renders so its age
   * is visible. Keying on a name would instead match "the Comet report" to "the
   * Comet sidecar" by convention, which is exactly the kind of inference this
   * feature refuses everywhere else.
   */
  private readonly liveSidecars = new Map<string, string>();

  constructor(
    private readonly store: JobStore,
    private readonly calibrationDir: string,
    private readonly secrets: string[] = [],
    /** Committed Mobula snapshots. Optional: their absence only makes the coverage panel partial. */
    private readonly liveDir: string | null = null,
  ) {}

  /**
   * Indexes the committed Mobula snapshots by (chain, target).
   *
   * Failure here is deliberately soft. A missing, unreadable or malformed
   * snapshot directory must never stop a report being served — Mobula is not
   * allowed to block the scan or the fork, and it is not allowed to block their
   * presentation either.
   */
  async indexLiveSidecars(): Promise<number> {
    if (!this.liveDir || !existsSync(this.liveDir)) return 0;
    let indexed = 0;
    for (const file of (await readdir(this.liveDir)).filter((f) => f.endsWith(".json"))) {
      try {
        const parsed = JSON.parse(await readFile(join(this.liveDir, file), "utf8")) as {
          target?: string;
          chainId?: number;
        };
        if (typeof parsed.target !== "string" || typeof parsed.chainId !== "number") continue;
        this.liveSidecars.set(`evm:${parsed.chainId}|${parsed.target.toLowerCase()}`, join(this.liveDir, file));
        indexed++;
      } catch {
        // A snapshot that will not parse is skipped, not fatal. The panel then
        // reports Mobula as absent for that target, which is accurate.
      }
    }
    return indexed;
  }

  /**
   * The Mobula snapshot for a (chain, target), or null.
   *
   * Null is a first-class answer that the composer renders as "Mobula data
   * unavailable" — never as "this asset is not held".
   */
  async loadLiveExposure(chainId: number, target: string): Promise<unknown | null> {
    const path = this.liveSidecars.get(`evm:${chainId}|${target.toLowerCase()}`);
    if (!path) return null;
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      return null;
    }
  }

  /** The optional, post-analysis asset sidecar for a live report. */
  async loadAssetContext(id: string): Promise<AssetContextArtifact | null> {
    if (!isSafeId(id) || this.calibration.has(id)) return null;
    return (await this.store.loadAssetContext(id)) as AssetContextArtifact | null;
  }

  /** Whether the submitter explicitly allowed a per-analysis Mobula request. */
  async assetContextRequested(id: string): Promise<boolean> {
    if (!isSafeId(id) || this.calibration.has(id)) return false;
    return (await this.store.loadReportMeta(id))?.refreshAssetContext === true;
  }

  /**
   * Indexes the committed calibration reports.
   *
   * Every file is READ and its own `disclosure.publishable` checked. A blocked
   * calibration report is indexed as blocked, not skipped: it should still be
   * visible as an entry that exists and is withheld, which is a more honest
   * listing than pretending the target was never examined.
   */
  async init(): Promise<{ indexed: number; blocked: number }> {
    if (!existsSync(this.calibrationDir)) return { indexed: 0, blocked: 0 };
    const files = (await readdir(this.calibrationDir)).filter((f) => f.endsWith(".json"));
    let blocked = 0;
    for (const file of files) {
      const path = join(this.calibrationDir, file);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      } catch {
        // A calibration file that will not parse is skipped rather than
        // crashing startup, and it is not silently "empty" either — it simply
        // does not appear, and the count below shows fewer than the directory.
        continue;
      }
      const id = `cal_${basename(file, ".json").replace(/[^A-Za-z0-9_-]/g, "-")}`;
      if (!isSafeId(id)) continue;
      const disclosure = parsed.disclosure as { publishable?: boolean } | undefined;
      const publishable = disclosure?.publishable === true;
      if (!publishable) blocked++;
      const block = parsed.block as { number?: string } | undefined;
      const target = parsed.target as { address?: string } | undefined;
      const verdict = parsed.verdict as { status?: string } | null | undefined;
      this.calibration.set(id, {
        path,
        item: {
          id,
          address: target?.address ?? "",
          chainId: Number(parsed.chainId ?? 1),
          block: block?.number ?? "",
          generatedAt: String(parsed.generatedAt ?? ""),
          schemaVersion: String(parsed.schemaVersion ?? ""),
          rulesetVersion: String(parsed.rulesetVersion ?? ""),
          verdictStatus: verdict?.status ?? null,
          origin: "calibration",
          title: basename(file, ".json"),
          hasExitRestriction: parsed.exitRestriction != null,
        },
      });
    }
    return { indexed: this.calibration.size, blocked };
  }

  /**
   * Everything a browser may see listed.
   *
   * Blocked reports are EXCLUDED from the listing, not shown as locked rows. A
   * row saying "withheld: <protocol>" is itself a signal about that protocol,
   * and the listing is a public surface. The count of blocked entries is
   * reported at startup, in the server log, where it belongs.
   */
  async listPublishable(): Promise<SavedReportListItem[]> {
    const live: SavedReportListItem[] = (await this.store.listReportMeta())
      .filter((m) => m.publishable)
      .map((m) => ({
        id: m.id,
        address: m.address,
        chainId: m.chainId,
        block: m.block,
        generatedAt: m.generatedAt,
        schemaVersion: m.schemaVersion,
        rulesetVersion: m.rulesetVersion,
        verdictStatus: m.verdictStatus,
        origin: "live" as const,
        title: `${m.address.slice(0, 10)}… @ block ${m.block}`,
        hasExitRestriction: m.hasExitRestriction,
      }));

    const calibration = [...this.calibration.values()].filter((c) => c.item.origin === "calibration").map((c) => c.item);
    // Only publishable calibration entries. `init` already recorded which are
    // blocked; they are counted, never listed.
    const publishableCalibration: SavedReportListItem[] = [];
    for (const entry of calibration) {
      const source = this.calibration.get(entry.id);
      if (!source) continue;
      const parsed = JSON.parse(await readFile(source.path, "utf8")) as { disclosure?: { publishable?: boolean } };
      if (parsed.disclosure?.publishable === true) publishableCalibration.push(entry);
    }

    return [...live, ...publishableCalibration].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  /**
   * Loads a report ONLY if it passes the publication gate.
   *
   * Returns `blocked` rather than throwing, so callers render a neutral refusal
   * instead of a stack trace — and crucially, in the blocked case NO REPORT
   * BYTES ARE RETURNED AT ALL. There is no variant of this function that hands
   * back a body plus a flag saying not to show it.
   */
  async loadPublishable(id: string): Promise<{ ok: true; value: LoadedReport } | { ok: false; reason: "not_found" | "blocked" }> {
    if (!isSafeId(id)) return { ok: false, reason: "not_found" };

    const calibrationEntry = this.calibration.get(id);
    if (calibrationEntry) {
      const parsed = JSON.parse(await readFile(calibrationEntry.path, "utf8")) as { disclosure?: { publishable?: boolean } };
      if (parsed.disclosure?.publishable !== true) return { ok: false, reason: "blocked" };
      return { ok: true, value: { id, origin: "calibration", report: publicValue(parsed, this.secrets) } };
    }

    const meta = await this.store.loadReportMeta(id);
    if (!meta) return { ok: false, reason: "not_found" };
    // The gate is re-read from the stored REPORT, not trusted from the sidecar.
    // The sidecar is a convenience index; the report is the artifact, and a
    // divergence between them must resolve toward the artifact.
    const report = (await this.store.loadReport(id)) as { disclosure?: { publishable?: boolean } } | null;
    if (!report) return { ok: false, reason: "not_found" };
    if (report.disclosure?.publishable !== true) return { ok: false, reason: "blocked" };
    return { ok: true, value: { id, origin: "live", report: publicValue(report, this.secrets) } };
  }
}

/**
 * The refusal a blocked report returns, on every transport.
 *
 * Deliberately says nothing about WHAT was blocked. The message is public, and a
 * message naming the signature or category would disclose the finding the gate
 * is withholding — the gate would then leak through its own error path.
 */
export const BLOCKED_MESSAGE =
  "This report is withheld pending manual review. Ripcord probed at least one privileged-looking function and could not attribute it to a guard it recognises, so the possibility that it is unguarded cannot be ruled out. Publishing it would amount to a vulnerability claim about a live contract, so it is held back until a human has reviewed it. This says nothing about whether such a vulnerability exists.";
