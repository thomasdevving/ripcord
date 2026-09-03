import { spawn } from "node:child_process";
// tsc watch emits a complete project before each successful compilation notice.
// Restart only then; the parent's SIGTERM handler drains its worker groups.
const compiler = spawn(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.server.json", "--watch", "--preserveWatchOutput"], { stdio: ["ignore", "pipe", "inherit"] });
let server;
let closing = false;
let restart = Promise.resolve();
let output = "";
const stop = child => new Promise(resolve => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
  child.once("exit", resolve);
  child.kill("SIGTERM");
});
compiler.stdout.on("data", chunk => {
  process.stdout.write(chunk);
  output += chunk.toString();
  if (!output.includes("Found 0 errors. Watching for file changes.")) return;
  output = "";
  restart = restart.then(async () => {
    await stop(server);
    if (!closing) server = spawn(process.execPath, ["dist-server/server/index.js"], { stdio: "inherit" });
  });
});
async function shutdown() { closing = true; await stop(compiler); await restart; await stop(server); }
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
compiler.on("exit", code => { if (!closing) { process.exitCode = code || 1; void shutdown(); } });
