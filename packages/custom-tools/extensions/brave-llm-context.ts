import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readPiEnvValue } from "../lib/env";

const BRAVE_LLM_CONTEXT_ENDPOINT = "https://api.search.brave.com/res/v1/llm/context";

const thresholdMode = ["strict", "balanced", "lenient"] as const;

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function clampText(value: unknown, maxChars = 24_000): string {
  const text = stringifyValue(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} chars omitted]`;
}

function toSearchParams(params: Record<string, unknown>) {
  const body: Record<string, unknown> = {
    q: params.query,
  };

  const mappings: Array<[string, string]> = [
    ["country", "country"],
    ["search_lang", "search_lang"],
    ["count", "count"],
    ["max_urls", "maximum_number_of_urls"],
    ["max_tokens", "maximum_number_of_tokens"],
    ["max_snippets", "maximum_number_of_snippets"],
    ["max_tokens_per_url", "maximum_number_of_tokens_per_url"],
    ["max_snippets_per_url", "maximum_number_of_snippets_per_url"],
    ["threshold", "context_threshold_mode"],
    ["local", "enable_local"],
    ["goggles", "goggles"],
  ];

  for (const [from, to] of mappings) {
    if (params[from] !== undefined && params[from] !== null && params[from] !== "") {
      body[to] = params[from];
    }
  }

  return body;
}

function buildLocationHeaders(location: Record<string, unknown> | undefined) {
  const headers: Record<string, string> = {};
  if (!location) return headers;

  const mappings: Array<[string, string]> = [
    ["lat", "X-Loc-Lat"],
    ["long", "X-Loc-Long"],
    ["city", "X-Loc-City"],
    ["state", "X-Loc-State"],
    ["state_name", "X-Loc-State-Name"],
    ["country", "X-Loc-Country"],
    ["postal_code", "X-Loc-Postal-Code"],
  ];

  for (const [from, to] of mappings) {
    const value = location[from];
    if (value !== undefined && value !== null && value !== "") headers[to] = String(value);
  }

  return headers;
}

function formatContext(data: any): string {
  const lines: string[] = [];
  const sources = data?.sources ?? {};
  const generic = Array.isArray(data?.grounding?.generic) ? data.grounding.generic : [];
  const map = Array.isArray(data?.grounding?.map) ? data.grounding.map : [];
  const poi = data?.grounding?.poi;

  let index = 1;
  const appendItem = (item: any, kind: string) => {
    const url = item?.url ?? "";
    const source = url ? sources[url] : undefined;
    const title = item?.title ?? source?.title ?? item?.name ?? "Untitled";
    const hostname = source?.hostname ? ` (${source.hostname})` : "";
    const age = Array.isArray(source?.age) && source.age[1] ? ` — ${source.age[1]}` : "";

    lines.push(`## [${index}] ${title}${hostname}${age}`);
    if (kind !== "generic") lines.push(`Type: ${kind}`);
    if (url) lines.push(`URL: ${url}`);

    const snippets = Array.isArray(item?.snippets) ? item.snippets : [];
    for (const snippet of snippets) {
      lines.push("", clampText(snippet, 4_000));
    }
    lines.push("");
    index += 1;
  };

  for (const item of generic) appendItem(item, "generic");
  if (poi) appendItem(poi, "poi");
  for (const item of map) appendItem(item, "map");

  if (lines.length === 0) return "No grounding context returned.";
  return clampText(lines.join("\n"));
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web with Brave LLM Context API and return extracted page content/snippets for grounding. Requires BRAVE_SEARCH_API_KEY.",
    promptSnippet: "Search the web and return extracted grounding context from relevant pages.",
    promptGuidelines: [
      "Use web_search when the user asks for current facts, web research, source-grounded answers, or documentation not present in the workspace.",
      "When using web_search, cite returned URLs/titles in the final answer when facts depend on search results.",
    ],
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        maxLength: 400,
        description: "Search query, max 50 words.",
      }),
      country: Type.Optional(Type.String({ description: "2-letter search country code or ALL. Default: US." })),
      search_lang: Type.Optional(Type.String({ description: "Language preference, e.g. en, ru. Default: en." })),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max search results to consider. Default: 20." })),
      max_urls: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max URLs in response. Default: 20." })),
      max_tokens: Type.Optional(Type.Integer({ minimum: 1024, maximum: 32768, description: "Approximate max tokens in context. Default: 8192." })),
      max_snippets: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max snippets across all URLs. Default: 50." })),
      max_tokens_per_url: Type.Optional(Type.Integer({ minimum: 512, maximum: 8192, description: "Max tokens per URL. Default: 4096." })),
      max_snippets_per_url: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max snippets per URL. Default: 50." })),
      threshold: Type.Optional(StringEnum(thresholdMode, { description: "Relevance threshold. Default: balanced." })),
      local: Type.Optional(Type.Boolean({ description: "Force local recall true/false. Omit for auto-detect from location headers." })),
      goggles: Type.Optional(Type.String({ description: "Brave Goggles URL or inline rules to alter ranking/filter sources." })),
      location: Type.Optional(
        Type.Object({
          lat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
          long: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
          city: Type.Optional(Type.String()),
          state: Type.Optional(Type.String()),
          state_name: Type.Optional(Type.String()),
          country: Type.Optional(Type.String()),
          postal_code: Type.Optional(Type.String()),
        }),
      ),
    }),

    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = args as Record<string, unknown>;
      const output = { ...input };
      const aliases: Array<[string, string]> = [
        ["q", "query"],
        ["maximum_number_of_urls", "max_urls"],
        ["maximum_number_of_tokens", "max_tokens"],
        ["maximum_number_of_snippets", "max_snippets"],
        ["maximum_number_of_tokens_per_url", "max_tokens_per_url"],
        ["maximum_number_of_snippets_per_url", "max_snippets_per_url"],
        ["context_threshold_mode", "threshold"],
        ["enable_local", "local"],
      ];

      for (const [from, to] of aliases) {
        if (output[to] === undefined && input[from] !== undefined) output[to] = input[from];
        delete output[from];
      }

      return output;
    },

    async execute(_toolCallId, params, signal, onUpdate) {
      const apiKey = readPiEnvValue("BRAVE_SEARCH_API_KEY");
      if (!apiKey) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "BRAVE_SEARCH_API_KEY is not set. Create a Brave Search API key and export it or add it to ~/.pi/agent/.env before using web_search.",
            },
          ],
        };
      }

      onUpdate?.({ content: [{ type: "text", text: `Searching Brave LLM Context for: ${params.query}` }] });

      const requestBody = toSearchParams(params as Record<string, unknown>);
      const locationHeaders = buildLocationHeaders(params.location as Record<string, unknown> | undefined);

      let response: Response;
      try {
        response = await fetch(BRAVE_LLM_CONTEXT_ENDPOINT, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip",
            "Content-Type": "application/json",
            "X-Subscription-Token": apiKey,
            ...locationHeaders,
          },
          body: JSON.stringify(requestBody),
          signal,
        });
      } catch (error) {
        const errorName = typeof error === "object" && error && "name" in error ? String(error.name) : "";
        if (errorName === "AbortError") throw error;
        return {
          isError: true,
          content: [{ type: "text", text: `Brave LLM Context API request failed: ${clampText(error, 2_000)}` }],
          details: {
            query: params.query,
            request: requestBody,
            hasLocationHeaders: Object.keys(locationHeaders).length > 0,
            error: stringifyValue(error),
          },
        };
      }

      const text = await response.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      if (!response.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Brave LLM Context API failed with HTTP ${response.status}: ${clampText(data, 4_000)}`,
            },
          ],
          details: { status: response.status, response: data },
        };
      }

      const genericCount = Array.isArray(data?.grounding?.generic) ? data.grounding.generic.length : 0;
      const mapCount = Array.isArray(data?.grounding?.map) ? data.grounding.map.length : 0;
      const hasPoi = Boolean(data?.grounding?.poi);
      const sources = data?.sources ?? {};

      return {
        content: [{ type: "text", text: formatContext(data) }],
        details: {
          query: params.query,
          status: response.status,
          counts: { generic: genericCount, map: mapCount, poi: hasPoi ? 1 : 0, sources: Object.keys(sources).length },
          sources,
        },
      };
    },
  });
}
