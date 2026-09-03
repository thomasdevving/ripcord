import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamJobEvents } from "../web/src/api.js";
import { applyJobEvent } from "../web/src/useJob.js";
class Source {
  static current: Source;
  listeners = new Map<string, (e: unknown) => void>();
  closed = false;
  onerror: (() => void) | null = null;
  constructor() { Source.current = this; }
  addEventListener(type: string, fn: (e: unknown) => void) { this.listeners.set(type, fn); }
  close() { this.closed = true; }
  emit(type: string, value: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(value) }); }
}
const summary = { jobId: "job_test", state: "running", lastSeq: 5, startedAt: null, phases: [], fork: { baseline: { established: true, detail: "A", transactions: [] }, mutation: null, reexit: null } } as any;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("EventSource", Source); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

describe("reconnect and buffered stream regressions", () => {
  it("waits for resnapshot before applying the replay tail and ignores older sequence numbers", async () => {
    let cursor = 5, release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const onEvent = vi.fn(e => { cursor = e.seq; });
    const stop = streamJobEvents("job_test", () => cursor, { onEvent, onTransport: vi.fn(), onResync: async () => { await gate; cursor = 9; } });
    Source.current.emit("resync", {});
    Source.current.emit("stage.started", { type: "stage.started", phase: "proxy", seq: 7 });
    Source.current.emit("stage.started", { type: "stage.started", phase: "ownership", seq: 10 });
    await tick(); expect(onEvent).not.toHaveBeenCalled();
    release(); await tick();
    expect(onEvent).toHaveBeenCalledOnce(); expect(onEvent.mock.calls[0]?.[0].seq).toBe(10);
    stop();
  });
  it("falls back to polling when a proxy stays open but buffers all frames", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ events: [], truncated: false, summary }) }));
    vi.stubGlobal("fetch", fetch);
    const onTransport = vi.fn();
    const stop = streamJobEvents("job_test", () => 5, { onEvent: vi.fn(), onResync: async () => false, onTransport });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(Source.current.closed).toBe(true);
    expect(fetch).toHaveBeenCalled(); expect(onTransport).toHaveBeenCalledWith("polling");
    stop();
  });
  it("closes a terminal stream after final resnapshot", async () => {
    const onTransport = vi.fn();
    const stop = streamJobEvents("job_test", () => 5, { onEvent: vi.fn(), onResync: async () => true, onTransport });
    Source.current.emit("job.state", { type: "job.state", state: "completed", seq: 6 });
    await tick();
    expect(Source.current.closed).toBe(true); expect(onTransport).toHaveBeenLastCalledWith("closed");
    stop();
  });
  it("preserves snapshot A when C arrives and supplies a running timestamp", () => {
    const started = applyJobEvent(summary, { type: "job.state", state: "running", seq: 6, at: "2026-09-03T10:00:00Z" } as any);
    expect(started.startedAt).toBe("2026-09-03T10:00:00Z");
    const result = applyJobEvent(started, { type: "fork.reexit.completed", detail: "C", transactions: [], seq: 7 } as any);
    expect(result.fork?.baseline?.detail).toBe("A"); expect(result.fork?.reexit?.detail).toBe("C");
    expect(applyJobEvent(result, { type: "job.state", state: "running", seq: 4 } as any)).toBe(result);
  });
});
