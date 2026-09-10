import type { AuthGateway, AuthResolution } from "../../server/auth-context.js";

export const TEST_ORGANIZATION_ID = "org_test_primary";
export const OTHER_ORGANIZATION_ID = "org_test_other";

/** Header-selectable identity for route tests. Production never has this adapter. */
export const testAuth: AuthGateway = {
  async resolve(headers): Promise<AuthResolution> {
    if (headers["x-test-auth"] === "anonymous") return { state: "anonymous" };
    const raw = headers["x-test-organization"];
    const organizationId = typeof raw === "string" ? raw : TEST_ORGANIZATION_ID;
    return {
      state: "authenticated",
      userId: `user_${organizationId}`,
      userName: "Test User",
      userEmail: `${organizationId}@example.test`,
      organizationId,
      organizationName: organizationId === TEST_ORGANIZATION_ID ? "Primary" : "Other",
      organizationSlug: organizationId,
    };
  },
};
