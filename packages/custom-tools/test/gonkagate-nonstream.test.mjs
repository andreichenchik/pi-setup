import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyGonkaGateResponse,
  buildGonkaGatePayload,
  createAssistantMessage,
  parseUsage,
  resolveReasoning,
} from "../lib/gonkagate-nonstream.js";

const model = {
  id: "moonshotai/kimi-k2.6",
  api: "gonkagate-nonstream-chat-completions",
  provider: "gonkagate",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("buildGonkaGatePayload", () => {
  it("uses non-streaming chat completions with GonkaGate reasoning", () => {
    const payload = buildGonkaGatePayload(
      model,
      {
        systemPrompt: "You are concise.",
        messages: [{ role: "user", content: "Use the tool", timestamp: 1 }],
        tools: [
          {
            name: "get_profile",
            description: "Get a profile",
            parameters: {
              type: "object",
              properties: { user: { type: "string" } },
              required: ["user"],
            },
          },
        ],
      },
      { maxTokens: 100, reasoning: "high", temperature: 0.2, toolChoice: "required" },
    );

    assert.equal(payload.stream, false);
    assert.deepEqual(payload.reasoning, { enabled: true, effort: "high" });
    assert.equal(payload.max_tokens, 100);
    assert.equal(payload.temperature, 0.2);
    assert.equal(payload.tool_choice, "required");
    assert.deepEqual(payload.messages.slice(0, 2), [
      { role: "system", content: "You are concise." },
      { role: "user", content: "Use the tool" },
    ]);
    assert.deepEqual(payload.tools[0], {
      type: "function",
      function: {
        name: "get_profile",
        description: "Get a profile",
        parameters: {
          type: "object",
          properties: { user: { type: "string" } },
          required: ["user"],
        },
      },
    });
  });

  it("replays assistant tool calls and tool results in OpenAI format", () => {
    const payload = buildGonkaGatePayload(model, {
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }],
          api: "x",
          provider: "x",
          model: "x",
          usage: {},
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "File contents" }],
          isError: false,
          timestamp: 2,
        },
      ],
    });

    assert.deepEqual(payload.messages, [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "read", content: "File contents" },
    ]);
  });
});

describe("applyGonkaGateResponse", () => {
  it("converts non-streaming tool calls into Pi toolCall content", () => {
    const output = createAssistantMessage(model, 123);

    applyGonkaGateResponse(
      output,
      {
        id: "resp_1",
        model: "moonshotai/Kimi-K2.6",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "functions.get_profile:0",
                  type: "function",
                  function: { name: "get_profile", arguments: '{"user":"andrei"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      model,
    );

    assert.equal(output.stopReason, "toolUse");
    assert.equal(output.responseId, "resp_1");
    assert.equal(output.responseModel, "moonshotai/Kimi-K2.6");
    assert.deepEqual(output.content, [
      {
        type: "toolCall",
        id: "functions.get_profile:0",
        name: "get_profile",
        arguments: { user: "andrei" },
      },
    ]);
  });

  it("converts normal text responses", () => {
    const output = createAssistantMessage(model, 123);

    applyGonkaGateResponse(
      output,
      {
        id: "resp_2",
        model: model.id,
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
      model,
    );

    assert.equal(output.stopReason, "stop");
    assert.deepEqual(output.content, [{ type: "text", text: "Done" }]);
  });
});

describe("parseUsage", () => {
  it("accounts for cache reads and writes", () => {
    const usage = parseUsage({
      prompt_tokens: 10,
      completion_tokens: 7,
      prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
    });

    assert.deepEqual(usage, {
      input: 5,
      output: 7,
      cacheRead: 2,
      cacheWrite: 3,
      totalTokens: 17,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });
});

describe("resolveReasoning", () => {
  it("defaults to GonkaGate high reasoning and clamps xhigh", () => {
    assert.deepEqual(resolveReasoning(undefined), { enabled: true, effort: "high" });
    assert.deepEqual(resolveReasoning("xhigh"), { enabled: true, effort: "high" });
    assert.deepEqual(resolveReasoning("low"), { enabled: true, effort: "low" });
  });
});
