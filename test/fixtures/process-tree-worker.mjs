import { spawn } from "node:child_process";
// Both ignore TERM, so only the manager's group-wide KILL backstop can finish.
process.on("SIGTERM", () => {});
process.on("message", message => {
  if (message.type !== "start") return;
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{}); process.send({ready:true}); setInterval(()=>{},1000)'], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  child.once("message", () => process.send({ type: "event", payload: { type: "stage.completed", phase: "preflight", detail: "test process tree ready", metrics: { workerPid: process.pid, descendantPid: child.pid } } }));
});
