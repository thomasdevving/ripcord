import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import {
  MAX_CANDIDATES_PER_SELECTOR,
  modelOutputSchema,
  verifyModelProposals,
} from "../server/ai-selector/verify.js";

describe("AI selector hypothesis verification", () => {
  it("accepts a parseable proposal only when the canonical signature hashes to the selector", () => {
    const [candidate] = verifyModelProposals({
      proposals: [{
        selector: "0x44c35d07",
        signature: "pause(bool,bool,bool,bool,bool)",
        capabilityHint: "pause_or_freeze",
        rationale: "Common five-flag pause shape.",
      }],
    }, ["0x44c35d07"]);

    expect(candidate).toMatchObject({
      canonicalSignature: "pause(bool,bool,bool,bool,bool)",
      validationStatus: "selector_hash_matched",
      computedSelector: "0x44c35d07",
      booleanArgumentsEnumerable: true,
      behaviorStatus: "not_attempted",
    });
  });

  it("retains a wrong guess as rejected and never makes it fork-eligible", () => {
    const [candidate] = verifyModelProposals({
      proposals: [{
        selector: "0x44c35d07",
        signature: "pause(bool)",
        capabilityHint: "pause_or_freeze",
        rationale: "A guess.",
      }],
    }, ["0x44c35d07"]);

    expect(candidate?.validationStatus).toBe("selector_hash_rejected");
    expect(candidate?.computedSelector).toBe(toFunctionSelector("pause(bool)"));
    expect(candidate?.behaviorStatus).toBe("unsupported_calldata");
  });

  it("does not confuse a real 4-byte collision with semantic proof", () => {
    expect(toFunctionSelector("burn(uint256)")).toBe("0x42966c68");
    expect(toFunctionSelector("collate_propagate_storage(bytes16)")).toBe("0x42966c68");

    const candidates = verifyModelProposals({
      proposals: [
        { selector: "0x42966c68", signature: "burn(uint256)", capabilityHint: "mint_or_burn", rationale: "Known signature." },
        { selector: "0x42966c68", signature: "collate_propagate_storage(bytes16)", capabilityHint: "unknown", rationale: "Known collision." },
      ],
    }, ["0x42966c68"]);

    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.validationStatus === "selector_hash_matched")).toBe(true);
    expect(candidates.every((candidate) => candidate.behaviorStatus !== "effect_confirmed")).toBe(true);
  });

  it("rejects prose, extra fields and malformed selectors at the schema boundary", () => {
    expect(() => modelOutputSchema.parse({
      proposals: [{ selector: "0x1234", signature: "function pause()", capabilityHint: "unknown", rationale: "x", trustMe: true }],
    })).toThrow();
  });

  it("ignores selectors that were not submitted", () => {
    const candidates = verifyModelProposals({
      proposals: [
        { selector: "0x42966c68", signature: "burn(uint256)", capabilityHint: "mint_or_burn", rationale: "requested" },
        { selector: "0x44c35d07", signature: "pause(bool,bool,bool,bool,bool)", capabilityHint: "pause_or_freeze", rationale: "not requested" },
      ],
    }, ["0x42966c68"]);
    expect(candidates.map((candidate) => candidate.selector)).toEqual(["0x42966c68"]);
  });

  it("caps matched and rejected proposals independently, so wrong guesses cannot displace a right one", () => {
    // The regression: the cap used to be charged before hashing, so five junk
    // guesses exhausted the budget and the correct sixth proposal was dropped
    // without ever being hashed.
    const proposals = [
      ...Array.from({ length: MAX_CANDIDATES_PER_SELECTOR }, (_, index) => ({
        selector: "0x44c35d07", signature: `junk${index}()`, capabilityHint: "unknown" as const, rationale: "wrong",
      })),
      { selector: "0x44c35d07", signature: "pause(bool,bool,bool,bool,bool)", capabilityHint: "pause_or_freeze" as const, rationale: "right" },
    ];
    const candidates = verifyModelProposals({ proposals }, ["0x44c35d07"]);
    const matched = candidates.filter((candidate) => candidate.validationStatus === "selector_hash_matched");

    expect(matched).toHaveLength(1);
    expect(matched[0]?.canonicalSignature).toBe("pause(bool,bool,bool,bool,bool)");
    // Matched candidates are returned first, and rejects stay visible but capped.
    expect(candidates[0]).toBe(matched[0]);
    expect(candidates.filter((c) => c.validationStatus !== "selector_hash_matched")).toHaveLength(MAX_CANDIDATES_PER_SELECTOR);
  });

  it("still bounds the number of matched candidates per selector", () => {
    const collisions = ["burn(uint256)", "collate_propagate_storage(bytes16)"];
    const proposals = Array.from({ length: MAX_CANDIDATES_PER_SELECTOR + 4 }, (_, index) => ({
      selector: "0x42966c68",
      signature: collisions[index % 2]!,
      capabilityHint: "unknown" as const,
      rationale: "bounded",
    }));
    // Duplicates collapse first, so only the two real collisions survive.
    expect(verifyModelProposals({ proposals }, ["0x42966c68"])).toHaveLength(2);
  });
});
