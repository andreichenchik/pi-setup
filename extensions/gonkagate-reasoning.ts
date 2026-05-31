import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyGonkaGateReasoning } from "../packages/custom-tools/lib/gonkagate-reasoning.js";

/**
 * Adds GonkaGate's nested reasoning object to OpenAI-compatible chat completion requests.
 */
export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "gonkagate" || ctx.model.api !== "openai-completions") {
      return undefined;
    }

    return applyGonkaGateReasoning(event.payload, pi.getThinkingLevel());
  });
}
