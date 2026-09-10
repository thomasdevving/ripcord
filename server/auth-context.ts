/** Runtime-neutral tenant context used by routes and lightweight test doubles. */
import type { IncomingHttpHeaders } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface OrganizationContext {
  userId: string;
  userName: string;
  userEmail: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
}

export type AuthResolution =
  | { state: "anonymous" }
  | { state: "organization_required"; userId: string; userName: string; userEmail: string }
  | ({ state: "authenticated" } & OrganizationContext);

export interface AuthGateway {
  resolve(headers: IncomingHttpHeaders): Promise<AuthResolution>;
}

export async function requireOrganization(auth: AuthGateway, request: FastifyRequest, reply: FastifyReply): Promise<OrganizationContext | null> {
  const identity = await auth.resolve(request.headers);
  if (identity.state === "anonymous") {
    reply.status(401).send({ error: { code: "unauthorized", message: "Sign in to access this workspace.", hint: null } });
    return null;
  }
  if (identity.state === "organization_required") {
    reply.status(409).send({ error: { code: "organization_required", message: "Select or create an organization before continuing.", hint: null } });
    return null;
  }
  return identity;
}

export async function optionalOrganization(auth: AuthGateway, request: FastifyRequest): Promise<OrganizationContext | null> {
  const identity = await auth.resolve(request.headers);
  return identity.state === "authenticated" ? identity : null;
}
