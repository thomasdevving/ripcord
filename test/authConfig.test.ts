import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../server/config.js";

describe("authentication configuration", () => {
  it("requires a durable production secret", () => {
    expect(() => loadConfig({ NODE_ENV: "production", RIPCORD_AUTH_SECRET: "too-short" })).toThrowError(ConfigError);
  });

  it("normalizes the configured public origin", () => {
    const config = loadConfig({ RIPCORD_PUBLIC_URL: "https://ripcord.example/" });
    expect(config.publicUrl).toBe("https://ripcord.example");
  });

  it.each([
    "ftp://ripcord.example",
    "https://ripcord.example/auth/callback",
    "https://user:password@ripcord.example",
    "https://ripcord.example?tenant=one",
  ])("rejects a public URL that is not an origin: %s", (publicUrl) => {
    expect(() => loadConfig({ RIPCORD_PUBLIC_URL: publicUrl })).toThrow(/RIPCORD_PUBLIC_URL/);
  });
});
