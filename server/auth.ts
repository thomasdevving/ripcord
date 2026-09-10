/** Better Auth integration and the one place HTTP identities become tenant context. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders } from "better-auth/node";
import { organization } from "better-auth/plugins";
import type { ServerConfig } from "./config.js";
import type { AuthResolution } from "./auth-context.js";

function createRipcordAuth(config: ServerConfig, database: DatabaseSync, migrationBootstrap = false) {
  const trustedOrigins = [config.publicUrl];
  if (config.nodeEnv !== "production") trustedOrigins.push("http://localhost:5173", "http://127.0.0.1:5173");
  return betterAuth({
    appName: "Ripcord",
    baseURL: config.publicUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    database,
    // Better Auth checks the schema as soon as the instance is constructed.
    // The first, short-lived instance exists to calculate and apply that very
    // schema, so suppress only its expected "missing tables" startup noise.
    ...(migrationBootstrap ? { logger: { disabled: true } } : {}),
    trustedOrigins,
    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.allowSignup,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
    },
    advanced: { database: { joins: true } },
    plugins: [
      organization({
        disableOrganizationDeletion: true,
        organizationLimit: 5,
        membershipLimit: 50,
      }),
    ],
  });
}

type RipcordAuth = ReturnType<typeof createRipcordAuth>;

export class AuthService {
  auth: RipcordAuth;
  private readonly database: DatabaseSync;

  constructor(private readonly config: ServerConfig) {
    mkdirSync(config.dataDir, { recursive: true });
    this.database = new DatabaseSync(join(config.dataDir, "auth.sqlite"));
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.auth = createRipcordAuth(config, this.database, true);
  }

  async init(): Promise<void> {
    const migrations = await getMigrations(this.auth.options);
    await migrations.runMigrations();
    this.auth = createRipcordAuth(this.config, this.database);
  }

  close(): void {
    this.database.close();
  }

  organizationExists(organizationId: string): boolean {
    return this.database.prepare("SELECT id FROM organization WHERE id = ? LIMIT 1").get(organizationId) !== undefined;
  }

  /** Mount Better Auth's Fetch handler without losing multiple Set-Cookie headers. */
  register(app: FastifyInstance): void {
    app.route({
      method: ["GET", "POST"],
      url: "/api/auth/*",
      handler: async (request, reply) => {
        try {
          const url = new URL(request.url, this.config.publicUrl);
          const headers = fromNodeHeaders(request.headers);
          const authRequest = new Request(url, {
            method: request.method,
            headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          });
          const response = await this.auth.handler(authRequest);
          reply.status(response.status);
          const cookies = response.headers.getSetCookie();
          response.headers.forEach((value, key) => {
            if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
          });
          if (cookies.length) reply.header("set-cookie", cookies);
          const body = response.body ? await response.text() : null;
          return body === null ? reply.send() : reply.type(response.headers.get("content-type") ?? "application/json").send(body);
        } catch (error) {
          request.log.error(error, "authentication request failed");
          return reply.status(500).send({ error: { code: "auth_failure", message: "Authentication could not be completed.", hint: null } });
        }
      },
    });
  }

  async resolve(headers: import("node:http").IncomingHttpHeaders): Promise<AuthResolution> {
    const authHeaders = fromNodeHeaders(headers);
    const session = await this.auth.api.getSession({ headers: authHeaders });
    if (!session) return { state: "anonymous" };
    const organizations = await this.auth.api.listOrganizations({ headers: authHeaders });
    const activeId = session.session.activeOrganizationId;
    const active = activeId
      ? organizations.find((candidate) => candidate.id === activeId)
      : organizations.length === 1 ? organizations[0] : undefined;
    if (!active) {
      return {
        state: "organization_required",
        userId: session.user.id,
        userName: session.user.name,
        userEmail: session.user.email,
      };
    }
    return {
      state: "authenticated",
      userId: session.user.id,
      userName: session.user.name,
      userEmail: session.user.email,
      organizationId: active.id,
      organizationName: active.name,
      organizationSlug: active.slug,
    };
  }
}
