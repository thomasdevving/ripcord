/** Runtime verification for Better Auth + built-in SQLite, executed after the server build. */
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "../dist-server/server/auth.js";
import { loadConfig } from "../dist-server/server/config.js";

const origin = "http://localhost:18080";
const dataDir = await mkdtemp(join(tmpdir(), "ripcord-auth-verify-"));
const config = loadConfig({
  NODE_ENV: "test",
  PORT: "18080",
  RIPCORD_DATA_DIR: dataDir,
  RIPCORD_PUBLIC_URL: origin,
  RIPCORD_AUTH_SECRET: "test-only-secret-with-at-least-32-characters",
  RIPCORD_ALLOW_SIGNUP: "true",
});
const auth = new AuthService(config);
const app = Fastify();

const cookieJar = new Map();
const applyCookies = (headers) => {
  const set = headers["set-cookie"];
  for (const value of Array.isArray(set) ? set : set ? [set] : []) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
};
const cookies = () => [...cookieJar].map(([name, value]) => `${name}=${value}`).join("; ");
const call = async (method, url, payload) => {
  const response = await app.inject({
    method,
    url,
    headers: { origin, ...(cookieJar.size ? { cookie: cookies() } : {}) },
    ...(payload === undefined ? {} : { payload }),
  });
  applyCookies(response.headers);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${method} ${url} returned ${response.statusCode}: ${response.body}`);
  }
  return response;
};

try {
  await auth.init();
  auth.register(app);
  await app.ready();

  await call("POST", "/api/auth/sign-up/email", {
    name: "Auth Verification",
    email: "verify@example.test",
    password: "correct-horse-battery-staple",
  });
  const created = await call("POST", "/api/auth/organization/create", {
    name: "Verification Organization",
    slug: "verification-organization",
  });
  const organization = created.json();
  if (!auth.organizationExists(organization.id)) throw new Error("created organization is not present in the auth database");
  const identity = await auth.resolve({ cookie: cookies(), origin });
  if (identity.state !== "authenticated") throw new Error(`expected authenticated organization context, saw ${identity.state}`);
  if (identity.organizationId !== organization.id || identity.organizationName !== "Verification Organization") {
    throw new Error("resolved tenant context does not match the organization created through Better Auth");
  }

  console.log(`✓ Better Auth migrated SQLite, created an account and resolved organization ${organization.id}`);
} finally {
  await app.close();
  auth.close();
  await rm(dataDir, { recursive: true, force: true });
}
