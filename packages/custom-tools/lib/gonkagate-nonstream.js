const DEFAULT_REASONING_EFFORT = "high";

/**
 * Models exposed by the non-streaming GonkaGate provider shim.
 */
export const GONKAGATE_NONSTREAM_MODELS = [
  {
    id: "moonshotai/kimi-k2.6",
    name: "Kimi K2.6 via GonkaGate (non-stream tools)",
    reasoning: true,
    thinkingLevelMap: { xhigh: "high" },
    input: ["text"],
    cost: { input: 0.000352, output: 0.000352, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 262_144,
  },
];

/**
 * Builds the OpenAI-compatible non-streaming GonkaGate chat completions payload.
 */
export function buildGonkaGatePayload(model, context, options = {}) {
  const payload = {
    model: model.id,
    messages: convertMessages(context),
    stream: false,
    reasoning: resolveReasoning(options.reasoning),
  };

  if (typeof options.maxTokens === "number") {
    payload.max_tokens = options.maxTokens;
  }

  if (typeof options.temperature === "number") {
    payload.temperature = options.temperature;
  }

  if (context.tools?.length) {
    payload.tools = context.tools.map(convertTool);
  }

  if (options.toolChoice) {
    payload.tool_choice = options.toolChoice;
  }

  return payload;
}

/**
 * Creates the initial Pi assistant message for a GonkaGate response.
 */
export function createAssistantMessage(model, timestamp = Date.now()) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createEmptyUsage(),
    stopReason: "stop",
    timestamp,
  };
}

/**
 * Applies a non-streaming chat completion response to a Pi assistant message.
 */
export function applyGonkaGateResponse(output, response, model, calculateCost = () => {}) {
  output.responseId = response.id;

  if (typeof response.model === "string" && response.model.length > 0 && response.model !== model.id) {
    output.responseModel = response.model;
  }

  output.usage = parseUsage(response.usage, model, calculateCost);

  const choice = response.choices?.[0];
  if (!choice) {
    output.stopReason = "error";
    output.errorMessage = "GonkaGate returned no choices";
    return output;
  }

  const stopReason = mapFinishReason(choice.finish_reason);
  output.stopReason = stopReason.stopReason;
  if (stopReason.errorMessage) {
    output.errorMessage = stopReason.errorMessage;
  }

  const message = choice.message ?? {};
  if (typeof message.content === "string" && message.content.length > 0) {
    output.content.push({ type: "text", text: message.content });
  }

  for (const call of message.tool_calls ?? []) {
    output.content.push(convertToolCall(call));
  }

  return output;
}

/**
 * Converts GonkaGate/OpenAI token usage into Pi usage accounting.
 */
export function parseUsage(rawUsage, model, calculateCost = () => {}) {
  const promptTokens = rawUsage?.prompt_tokens ?? 0;
  const cacheReadTokens = rawUsage?.prompt_tokens_details?.cached_tokens ?? rawUsage?.prompt_cache_hit_tokens ?? 0;
  const cacheWriteTokens = rawUsage?.prompt_tokens_details?.cache_write_tokens ?? 0;
  const outputTokens = rawUsage?.completion_tokens ?? 0;

  const usage = {
    input: Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens),
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens: promptTokens + outputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  calculateCost(model, usage);
  return usage;
}

/**
 * Maps a Pi thinking level into GonkaGate's reasoning block.
 */
export function resolveReasoning(level) {
  const effort = level === "xhigh" ? DEFAULT_REASONING_EFFORT : (level ?? DEFAULT_REASONING_EFFORT);
  return { enabled: true, effort };
}

function convertMessages(context) {
  const messages = [];

  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }

  for (const message of context.messages ?? []) {
    if (message.role === "user") {
      messages.push({ role: "user", content: convertUserContent(message.content) });
      continue;
    }

    if (message.role === "assistant") {
      messages.push(convertAssistantMessage(message));
      continue;
    }

    if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: stringifyToolResultContent(message.content),
      });
    }
  }

  return messages;
}

function convertUserContent(content) {
  if (typeof content === "string") {
    return content;
  }

  return content.map((block) => {
    if (block.type === "image") {
      return {
        type: "image_url",
        image_url: { url: `data:${block.mimeType};base64,${block.data}` },
      };
    }

    return { type: "text", text: block.text };
  });
}

function convertAssistantMessage(message) {
  const text = message.content
    .filter((block) => block.type === "text" || block.type === "thinking")
    .map((block) => (block.type === "thinking" ? `<thinking>\n${block.thinking}\n</thinking>` : block.text))
    .join("\n");
  const toolCalls = message.content.filter((block) => block.type === "toolCall");

  return {
    role: "assistant",
    content: text.length > 0 ? text : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map(convertPiToolCall) } : {}),
  };
}

function stringifyToolResultContent(content) {
  const text = (content ?? [])
    .map((block) => (block.type === "text" ? block.text : `[image: ${block.mimeType}]`))
    .join("\n");
  return text.length > 0 ? text : "{}";
}

function convertTool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function convertPiToolCall(block) {
  return {
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      arguments: JSON.stringify(block.arguments ?? {}),
    },
  };
}

function convertToolCall(call) {
  return {
    type: "toolCall",
    id: call.id ?? "",
    name: call.function?.name ?? "",
    arguments: parseToolArguments(call.function?.arguments),
  };
}

function parseToolArguments(rawArguments) {
  if (typeof rawArguments !== "string" || rawArguments.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawArguments);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapFinishReason(reason) {
  switch (reason) {
    case null:
    case undefined:
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    default:
      return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
  }
}

function createEmptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
