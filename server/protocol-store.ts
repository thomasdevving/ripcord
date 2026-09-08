/** Durable local protocol and protocol-scan storage for the single-replica app. */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeJoin } from "./jobs/store.js";
import type { ProtocolRecord, ProtocolTarget } from "./shared/protocols.js";

export interface StoredProtocolScanTarget {
  targetId: string;
  jobId: string | null;
  submissionError: { message: string; hint: string | null } | null;
}

export interface StoredProtocolScan {
  id: string;
  protocolId: string;
  sequence: number;
  kind: "baseline" | "rescan";
  createdAt: string;
  idempotencyKey: string | null;
  targets: StoredProtocolScanTarget[];
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TARGET_ID_RE = /^target_[a-f0-9]{16}$/;

function validProtocol(value: unknown): value is ProtocolRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProtocolRecord>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string" &&
    Array.isArray(item.targets) &&
    item.targets.every((target) =>
      target &&
      typeof target.id === "string" && TARGET_ID_RE.test(target.id) &&
      typeof target.label === "string" &&
      typeof target.address === "string" && ADDRESS_RE.test(target.address) &&
      target.chainId === 1,
    )
  );
}

function validScan(value: unknown): value is StoredProtocolScan {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredProtocolScan>;
  return (
    typeof item.id === "string" &&
    typeof item.protocolId === "string" &&
    Number.isInteger(item.sequence) && Number(item.sequence) > 0 &&
    (item.kind === "baseline" || item.kind === "rescan") &&
    typeof item.createdAt === "string" &&
    (item.idempotencyKey === null || typeof item.idempotencyKey === "string") &&
    Array.isArray(item.targets) &&
    item.targets.every((target) =>
      target &&
      typeof target.targetId === "string" && TARGET_ID_RE.test(target.targetId) &&
      (target.jobId === null || typeof target.jobId === "string") &&
      (target.submissionError === null ||
        (typeof target.submissionError?.message === "string" &&
          (target.submissionError.hint === null || typeof target.submissionError.hint === "string"))),
    )
  );
}

export class ProtocolStore {
  readonly protocolsDir: string;
  readonly scansDir: string;
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.protocolsDir = join(dataDir, "protocols");
    this.scansDir = join(dataDir, "protocol-scans");
  }

  async init(): Promise<void> {
    await Promise.all([mkdir(this.protocolsDir, { recursive: true }), mkdir(this.scansDir, { recursive: true })]);
  }

  private async writeAtomic(path: string, value: unknown): Promise<void> {
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await rename(tmp, path);
  }

  private async read(path: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async createProtocol(name: string, targets: Array<Omit<ProtocolTarget, "id">>): Promise<ProtocolRecord> {
    const now = new Date().toISOString();
    const protocol: ProtocolRecord = {
      id: `protocol_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      name,
      targets: targets.map((target) => ({
        ...target,
        id: `target_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      })),
      createdAt: now,
      updatedAt: now,
    };
    const write = this.writeTail.then(() => this.writeAtomic(safeJoin(this.protocolsDir, protocol.id), protocol));
    this.writeTail = write.catch(() => undefined);
    await write;
    return protocol;
  }

  async getProtocol(id: string): Promise<ProtocolRecord | null> {
    let value: unknown;
    try { value = await this.read(safeJoin(this.protocolsDir, id)); }
    catch { return null; }
    return validProtocol(value) ? value : null;
  }

  async listProtocols(): Promise<ProtocolRecord[]> {
    if (!existsSync(this.protocolsDir)) return [];
    const result: ProtocolRecord[] = [];
    for (const file of (await readdir(this.protocolsDir)).filter((entry) => entry.endsWith(".json"))) {
      const value = await this.read(join(this.protocolsDir, file));
      if (validProtocol(value)) result.push(value);
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createScan(protocol: ProtocolRecord, idempotencyKey: string | null): Promise<{ scan: StoredProtocolScan; deduplicated: boolean }> {
    let outcome: { scan: StoredProtocolScan; deduplicated: boolean } | null = null;
    const write = this.writeTail.then(async () => {
      const existing = await this.listScans(protocol.id);
      const duplicate = idempotencyKey ? existing.find((scan) => scan.idempotencyKey === idempotencyKey) : null;
      if (duplicate) {
        outcome = { scan: duplicate, deduplicated: true };
        return;
      }
      const sequence = (existing.at(-1)?.sequence ?? 0) + 1;
      const scan: StoredProtocolScan = {
        id: `pscan_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        protocolId: protocol.id,
        sequence,
        kind: sequence === 1 ? "baseline" : "rescan",
        createdAt: new Date().toISOString(),
        idempotencyKey,
        // Written before any heavyweight work starts. If the process stops
        // half-way through admission, every untouched target remains a loud
        // submission failure instead of disappearing from the batch.
        targets: protocol.targets.map((target) => ({
          targetId: target.id,
          jobId: null,
          submissionError: {
            message: "The service stopped before this contract could be submitted.",
            hint: "Start a new protocol scan.",
          },
        })),
      };
      await this.writeAtomic(safeJoin(this.scansDir, scan.id), scan);
      outcome = { scan, deduplicated: false };
    });
    this.writeTail = write.catch(() => undefined);
    await write;
    if (!outcome) throw new Error("protocol scan was not persisted");
    return outcome;
  }

  async saveScanTarget(scan: StoredProtocolScan, target: StoredProtocolScanTarget): Promise<void> {
    const write = this.writeTail.then(async () => {
      const currentRaw = await this.read(safeJoin(this.scansDir, scan.id));
      if (!validScan(currentRaw)) throw new Error("protocol scan is missing or invalid");
      const index = currentRaw.targets.findIndex((item) => item.targetId === target.targetId);
      if (index === -1) throw new Error("protocol scan target is missing");
      currentRaw.targets[index] = target;
      await this.writeAtomic(safeJoin(this.scansDir, scan.id), currentRaw);
      scan.targets = currentRaw.targets;
    });
    this.writeTail = write.catch(() => undefined);
    await write;
  }

  async listScans(protocolId: string): Promise<StoredProtocolScan[]> {
    if (!existsSync(this.scansDir)) return [];
    const result: StoredProtocolScan[] = [];
    for (const file of (await readdir(this.scansDir)).filter((entry) => entry.endsWith(".json"))) {
      const value = await this.read(join(this.scansDir, file));
      if (validScan(value) && value.protocolId === protocolId) result.push(value);
    }
    return result.sort((a, b) => a.sequence - b.sequence);
  }

  async findScanByIdempotencyKey(protocolId: string, key: string): Promise<StoredProtocolScan | null> {
    return (await this.listScans(protocolId)).find((scan) => scan.idempotencyKey === key) ?? null;
  }

  async referencedJobIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    if (!existsSync(this.scansDir)) return ids;
    for (const file of (await readdir(this.scansDir)).filter((entry) => entry.endsWith(".json"))) {
      const value = await this.read(join(this.scansDir, file));
      if (!validScan(value)) continue;
      for (const target of value.targets) if (target.jobId) ids.add(target.jobId);
    }
    return ids;
  }
}

export function validateProtocolInput(raw: unknown):
  | { ok: true; name: string; targets: Array<Omit<ProtocolTarget, "id">> }
  | { ok: false; message: string } {
  if (!raw || typeof raw !== "object") return { ok: false, message: "A protocol name and at least one contract are required." };
  const body = raw as { name?: unknown; targets?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 80) return { ok: false, message: "Protocol name must be between 2 and 80 characters." };
  if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > 4) {
    return { ok: false, message: "A protocol must contain between 1 and 4 contracts in this single-replica version." };
  }
  const targets: Array<Omit<ProtocolTarget, "id">> = [];
  const seen = new Set<string>();
  for (let index = 0; index < body.targets.length; index++) {
    const rawTarget = body.targets[index];
    if (!rawTarget || typeof rawTarget !== "object") return { ok: false, message: `Contract ${index + 1} is invalid.` };
    const target = rawTarget as { label?: unknown; address?: unknown; chainId?: unknown };
    const contractAddress = typeof target.address === "string" ? target.address.trim() : "";
    if (!ADDRESS_RE.test(contractAddress)) return { ok: false, message: `Contract ${index + 1} must be a 20-byte EVM address.` };
    const normalized = contractAddress.toLowerCase();
    if (seen.has(normalized)) return { ok: false, message: `Contract ${index + 1} duplicates an address already in this protocol.` };
    seen.add(normalized);
    const label = typeof target.label === "string" && target.label.trim() ? target.label.trim() : `Contract ${index + 1}`;
    if (label.length > 80) return { ok: false, message: `Contract ${index + 1} label must be at most 80 characters.` };
    const chainId = target.chainId === undefined ? 1 : Number(target.chainId);
    if (chainId !== 1) return { ok: false, message: "This version supports Ethereum Mainnet only." };
    targets.push({ label, address: contractAddress, chainId });
  }
  return { ok: true, name, targets };
}
