/**
 * Private storage for selector-hypothesis sidecars.
 *
 * THREE DIRECTORIES, and the split is the point:
 *   records/     the small status record. The only thing any route reads.
 *   private/     the full artifact for a run that produced nothing to withhold.
 *   quarantine/  the full artifact for a run that did. Never served, by any path.
 *
 * THE DECISION HAPPENS BEFORE THE WRITE, so the artifact is written straight to
 * its destination. There is no window in which quarantined evidence sits in the
 * ordinary private directory waiting to be moved, and no move to fail halfway.
 *
 * ORDER: artifact first, then the record. A crash between them leaves a record
 * still `pending_private` with an artifact on disk, which `recoverOnBoot`
 * resolves — to quarantine if the artifact warrants it, otherwise to
 * unavailable. Never to publishable. The reverse order would leave a record
 * claiming a status for an artifact that does not exist.
 *
 * Atomic write and safe id resolution follow jobs/store.ts, whose comments carry
 * the reasoning: temp file in the SAME directory then rename, and an id from a
 * URL never becomes a path.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeJoin } from "../jobs/store.js";
import { parseArtifact, type AiSelectorArtifact } from "./artifact.js";
import { decideDisclosure, projectPublicView, recoverOnBoot, type AiSidecarRecord } from "./disclosure.js";
import type { AiSidecarPublicView } from "../shared/ai-disclosure.js";

export class AiSidecarStore {
  private readonly recordsDir: string;
  private readonly privateDir: string;
  private readonly quarantineDir: string;

  constructor(dataDir: string) {
    this.recordsDir = join(dataDir, "ai-selector");
    this.privateDir = join(dataDir, "ai-selector-private");
    this.quarantineDir = join(dataDir, "ai-selector-quarantine");
  }

  async init(): Promise<void> {
    for (const dir of [this.recordsDir, this.privateDir, this.quarantineDir]) {
      await mkdir(dir, { recursive: true });
    }
  }

  private async writeAtomic(path: string, contents: string): Promise<void> {
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, contents, "utf8");
    await rename(tmp, path);
  }

  private async readJson(path: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private dirFor(location: "private" | "quarantine"): string {
    return location === "quarantine" ? this.quarantineDir : this.privateDir;
  }

  /** Marks a run as started. Private from this moment, and publishable from no path but a decision. */
  async markPending(reportId: string): Promise<AiSidecarRecord> {
    const record: AiSidecarRecord = {
      reportId,
      status: "pending_private",
      reason: "the selector-hypothesis run is in progress and is private until it finishes",
      updatedAt: new Date().toISOString(),
      artifactLocation: null,
    };
    await this.writeAtomic(safeJoin(this.recordsDir, reportId), JSON.stringify(record, null, 2));
    return record;
  }

  /**
   * Stores a finished run: decide, write the artifact to the directory the
   * decision names, then publish the status in one atomic rename.
   */
  async completeRun(reportId: string, artifact: AiSelectorArtifact): Promise<AiSidecarRecord> {
    const decision = decideDisclosure(artifact);
    await this.writeAtomic(safeJoin(this.dirFor(decision.location), reportId), JSON.stringify(artifact, null, 2));
    const record: AiSidecarRecord = {
      reportId,
      status: decision.status,
      reason: decision.reason,
      updatedAt: new Date().toISOString(),
      artifactLocation: decision.location,
    };
    await this.writeAtomic(safeJoin(this.recordsDir, reportId), JSON.stringify(record, null, 2));
    return record;
  }

  /** Records that a run could not produce a sidecar. Never carries a contract detail. */
  async markUnavailable(reportId: string, reason: string): Promise<AiSidecarRecord> {
    const record: AiSidecarRecord = {
      reportId, status: "unavailable", reason, updatedAt: new Date().toISOString(), artifactLocation: null,
    };
    await this.writeAtomic(safeJoin(this.recordsDir, reportId), JSON.stringify(record, null, 2));
    return record;
  }

  async loadRecord(reportId: string): Promise<AiSidecarRecord | null> {
    return (await this.readJson(safeJoin(this.recordsDir, reportId))) as AiSidecarRecord | null;
  }

  /**
   * Loads the artifact behind a record. Private: no route may call this and
   * return the result. A document that fails to parse comes back null rather
   * than partially — the gate must never see half a record.
   */
  async loadArtifact(record: AiSidecarRecord): Promise<AiSelectorArtifact | null> {
    if (!record.artifactLocation) return null;
    const raw = await this.readJson(safeJoin(this.dirFor(record.artifactLocation), record.reportId));
    return raw === null ? null : parseArtifact(raw);
  }

  /** THE ONLY outward path. Everything a route serves comes through here. */
  async loadPublicView(reportId: string): Promise<AiSidecarPublicView> {
    const record = await this.loadRecord(reportId);
    if (!record) return { status: "not_requested" };
    return projectPublicView(record, await this.loadArtifact(record));
  }

  /**
   * Resolves every run left `pending_private` by a crash or restart. Returns the
   * ids it touched and their new status, for a log line that names nothing else.
   */
  async recoverInterrupted(): Promise<{ reportId: string; status: AiSidecarRecord["status"] }[]> {
    const touched: { reportId: string; status: AiSidecarRecord["status"] }[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.recordsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return touched;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const reportId = entry.slice(0, -".json".length);
      const record = await this.loadRecord(reportId).catch(() => null);
      if (!record || record.status !== "pending_private") continue;
      // An interrupted run may still have written its artifact to either
      // directory, so both are checked before deciding it saw nothing.
      const artifact =
        (await this.loadArtifact({ ...record, artifactLocation: "quarantine" })) ??
        (await this.loadArtifact({ ...record, artifactLocation: "private" }));
      const recovered = recoverOnBoot(record, artifact);
      await this.writeAtomic(safeJoin(this.recordsDir, reportId), JSON.stringify(recovered, null, 2));
      touched.push({ reportId, status: recovered.status });
    }
    return touched;
  }
}
