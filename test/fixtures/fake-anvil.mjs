#!/usr/bin/env node

/**
 * Tiny Anvil-shaped JSON-RPC child used by the port-ownership tests.
 *
 * It deliberately performs the bind itself and announces the selected port
 * only from the listening callback. That preserves the property under test:
 * port 0 is allocated atomically by the OS in the child that will serve RPC.
 */
import { createServer } from "node:http";

const valueAfter = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};

const requestedPort = Number(valueAfter("--port", "0"));
const block = BigInt(valueAfter("--fork-block-number", "0"));
const upstream = valueAfter("--fork-url", "");
const blockHex = `0x${block.toString(16)}`;
const hash = `0x${"ab".repeat(32)}`;

if (upstream.includes("emit-secret.invalid")) {
  process.stderr.write(`failed to connect to ${upstream} Authorization=super-secret-token\n`);
  process.exit(1);
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += String(chunk); });
  req.on("end", () => {
    let id = 1;
    let method = "";
    try {
      const parsed = JSON.parse(raw);
      id = parsed.id;
      method = parsed.method;
    } catch { /* malformed requests receive the default scalar response */ }

    const result = method === "eth_getBlockByNumber"
      ? {
          number: blockHex,
          hash,
          timestamp: "0x65000000",
          baseFeePerGas: "0x1",
          transactions: [],
        }
      : blockHex;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
});

server.once("error", (err) => {
  process.stderr.write(`${err.code ?? "listen_error"}\n`);
  process.exit(1);
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(2);
  process.stdout.write(`Listening on 127.0.0.1:${address.port}\n`);
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
