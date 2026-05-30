import {
  calculateCost,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  applyGonkaGateResponse,
  buildGonkaGatePayload,
  createAssistantMessage,
  GONKAGATE_NONSTREAM_MODELS,
} from "../lib/gonkagate-nonstream.js";

const GONKAGATE_BASE_URL = "https://api.gonkagate.com/v1";
const CHAT_COMPLETIONS_URL = `${GONKAGATE_BASE_URL}/chat/completions`;

/**
 * Calls GonkaGate chat completions without SSE streaming so tool calls arrive in the final JSON payload.
 */
export function streamGonkaGateNonStreaming(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output = createAssistantMessage(model) as AssistantMessage;

    try {
      const apiKey = options?.apiKey;
      if (!apiKey) {
        throw new Error("No GonkaGate API key. Run /login gonkagate or configure GONKAGATE_API_KEY.");
      }

      stream.push({ type: "start", partial: output });

      const basePayload = buildGonkaGatePayload(model, context, {
        maxTokens: options?.maxTokens,
        reasoning: options?.reasoning,
        temperature: options?.temperature,
        toolChoice: options?.toolChoice,
      });
      const nextPayload = await options?.onPayload?.(basePayload, model);
      const payload = nextPayload ?? basePayload;

      const response = await fetch(CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          ...model.headers,
          ...options?.headers,
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: options?.signal,
      });

      await options?.onResponse?.(
        { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
        model,
      );

      if (!response.ok) {
        throw new Error(`GonkaGate request failed: ${response.status} ${await response.text()}`);
      }

      const data = await response.json();
      applyGonkaGateResponse(output, data, model, calculateCost);

      for (const [contentIndex, block] of output.content.entries()) {
        if (block.type === "text") {
          stream.push({ type: "text_start", contentIndex, partial: output });
          stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
          stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
          continue;
        }

        if (block.type === "toolCall") {
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
          stream.push({
            type: "toolcall_delta",
            contentIndex,
            delta: JSON.stringify(block.arguments ?? {}),
            partial: output,
          });
          stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
        }
      }

      if (output.stopReason === "error") {
        throw new Error(output.errorMessage ?? "GonkaGate returned an error stop reason");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("gonkagate", {
    name: "GonkaGate",
    baseUrl: GONKAGATE_BASE_URL,
    apiKey: "$GONKAGATE_API_KEY",
    api: "gonkagate-nonstream-chat-completions",
    models: GONKAGATE_NONSTREAM_MODELS,
    streamSimple: streamGonkaGateNonStreaming,
  });
}
