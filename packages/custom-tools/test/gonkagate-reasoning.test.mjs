import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyGonkaGateReasoning, mapGonkaGateReasoningEffort } from "../lib/gonkagate-reasoning.js";

describe("mapGonkaGateReasoningEffort", () => {
  it("maps Pi thinking levels to GonkaGate efforts", () => {
    assert.equal(mapGonkaGateReasoningEffort("minimal"), "low");
    assert.equal(mapGonkaGateReasoningEffort("low"), "low");
    assert.equal(mapGonkaGateReasoningEffort("medium"), "medium");
    assert.equal(mapGonkaGateReasoningEffort("high"), "high");
    assert.equal(mapGonkaGateReasoningEffort("xhigh"), "high");
  });

  it("does not map off or unknown levels", () => {
    assert.equal(mapGonkaGateReasoningEffort("off"), undefined);
    assert.equal(mapGonkaGateReasoningEffort(undefined), undefined);
  });
});

describe("applyGonkaGateReasoning", () => {
  it("adds GonkaGate reasoning to object payloads", () => {
    assert.deepEqual(applyGonkaGateReasoning({ model: "moonshotai/kimi-k2.6", stream: true }, "high"), {
      model: "moonshotai/kimi-k2.6",
      stream: true,
      reasoning: {
        enabled: true,
        effort: "high",
      },
    });
  });

  it("returns undefined when no reasoning should be applied", () => {
    assert.equal(applyGonkaGateReasoning({ model: "moonshotai/kimi-k2.6" }, "off"), undefined);
    assert.equal(applyGonkaGateReasoning(null, "high"), undefined);
  });
});
