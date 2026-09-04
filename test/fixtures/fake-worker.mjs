/**
 * A stand-in for `server/jobs/worker.ts`, used by the job-manager tests.
 *
 * The manager's contract with its worker is: fork it, send one `start`, receive
 * `event`/`done`/`failed` over IPC, and be able to kill it at any moment. That
 * is what the tests exercise, and none of it needs a real analysis — driving the
 * engine here would make the tests need an RPC endpoint and minutes per case.
 *
 * Behaviour is selected by the address in the start message:
 *
 *   0x…01  emit two events, then succeed with a small report
 *   0x…02  fail with a classified error
 *   0x…03  hang forever (for timeout and cancellation)
 *   0x…04  exit without ever answering (a worker that dies mid-run)
 *   0x…05  succeed with a NON-publishable report (the disclosure gate)
 */
const REPORT = (publishable) => ({
  schemaVersion: "0.13.0",
  rulesetVersion: "0.13.0",
  generatedAt: "2026-01-01T00:00:00.000Z",
  chainId: 1,
  block: { number: "100", hash: "0xdeadbeef" },
  target: { address: "0x00000000000000000000000000000000000000aa", hasCode: true, bytecodeSize: 2, bytecodeHash: null },
  disclosure: { publishable },
  verdict: { status: "undetermined" },
  exitRestriction: null,
});

process.on("message", (msg) => {
  if (msg?.type !== "start") return;
  const scenario = msg.address.slice(-2);

  if (scenario === "03") {
    // Hangs. The manager must be able to time it out or cancel it.
    setInterval(() => {}, 1 << 30);
    return;
  }

  if (scenario === "04") {
    // Dies without answering — the manager must not leave the job `running`.
    process.exit(7);
  }

  process.send({ type: "event", payload: { type: "stage.started", phase: "preflight" } });
  process.send({
    type: "event",
    payload: { type: "stage.completed", phase: "preflight", detail: "fake preflight" },
  });

  if (scenario === "02") {
    process.send({ type: "failed", code: "rpc_unreachable", message: "The RPC endpoint could not be reached.", hint: "Retry." }, () =>
      process.exit(1),
    );
    return;
  }

  const publishable = scenario !== "05";
  // The real worker flushes terminal messages before exiting — a large report
  // is queued asynchronously and `process.exit` discards it. Mirrored here so
  // the tests exercise the same handshake.
  process.send(
    {
      type: "done",
      report: JSON.stringify(REPORT(publishable)),
      publishable,
      verdictStatus: "undetermined",
      hasExitRestriction: false,
      generatedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: "0.13.0",
      rulesetVersion: "0.13.0",
      blockHash: "0xdeadbeef",
    },
    () => process.exit(0),
  );
});

process.on("disconnect", () => process.exit(0));
