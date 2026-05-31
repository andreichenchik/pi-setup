const GONKAGATE_REASONING_EFFORT_BY_LEVEL = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
};

/**
 * Maps a Pi thinking level to the reasoning effort values accepted by GonkaGate.
 */
export function mapGonkaGateReasoningEffort(thinkingLevel) {
  return GONKAGATE_REASONING_EFFORT_BY_LEVEL[thinkingLevel];
}

/**
 * Returns an OpenAI-compatible payload with GonkaGate's nested reasoning control.
 */
export function applyGonkaGateReasoning(payload, thinkingLevel) {
  const effort = mapGonkaGateReasoningEffort(thinkingLevel);
  if (!effort || !isRecord(payload)) {
    return undefined;
  }

  return {
    ...payload,
    reasoning: {
      enabled: true,
      effort,
    },
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
