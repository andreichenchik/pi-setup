import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Defuddle } from "defuddle/node";
import { PDFParse } from "pdf-parse";
import { parseHTML } from "linkedom";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const outputFormats = ["markdown", "html", "text"] as const;
const replyModes = ["extractors", "all", "none"] as const;
const inputTypes = ["auto", "url", "html", "text", "path"] as const;

const DEFAULT_MAX_CHARS = 30_000;
const DEFAULT_MAX_FETCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 45;
const MAX_MAX_CHARS = 200_000;
const MAX_FETCH_BYTES = 50 * 1024 * 1024;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeInputType(value: unknown): (typeof inputTypes)[number] {
  return inputTypes.includes(value as any) ? (value as any) : "auto";
}

function normalizeFormat(value: unknown): (typeof outputFormats)[number] {
  return outputFormats.includes(value as any) ? (value as any) : "markdown";
}

function normalizeReplyMode(value: unknown): (typeof replyModes)[number] {
  return replyModes.includes(value as any) ? (value as any) : "extractors";
}

function includeRepliesValue(mode: (typeof replyModes)[number]): boolean | "extractors" {
  if (mode === "all") return true;
  if (mode === "none") return false;
  return "extractors";
}

function looksLikeUrl(value: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(value.trim());
}

function normalizeUrl(raw: string): string {
  let value = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  return url.toString();
}

function isProbablyHtml(value: string): boolean {
  const trimmed = value.trimStart();
  return /^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed) || /<(article|main|body|p|div|section|h1)[\s>]/i.test(trimmed);
}

function isHtmlContentType(contentType: string): boolean {
  return /\b(text\/html|application\/xhtml\+xml)\b/i.test(contentType);
}

function isTextLikeContentType(contentType: string): boolean {
  return (
    /^text\//i.test(contentType) ||
    /\b(application\/(json|ld\+json|xml|rss\+xml|atom\+xml|javascript|x-javascript|typescript|x-ndjson))\b/i.test(contentType) ||
    /\b(markdown|yaml|toml|csv)\b/i.test(contentType)
  );
}

function isPdfContentType(contentType: string): boolean {
  return /\bapplication\/pdf\b/i.test(contentType);
}

function looksLikePdfBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

function mergeHeaders(base: HeadersInit | undefined, extra: HeadersInit | undefined): Headers {
  const headers = new Headers(base);
  if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
  return headers;
}

function makeHeaders(language?: string): Headers {
  const headers = new Headers({
    "User-Agent": DEFAULT_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.5",
  });
  if (language) headers.set("Accept-Language", language);
  return headers;
}

function createTimedSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let parentAbort: (() => void) | undefined;

  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  if (parent?.aborted) {
    abort(parent.reason);
  } else if (parent) {
    parentAbort = () => abort(parent.reason);
    parent.addEventListener("abort", parentAbort, { once: true });
  }

  if (timeoutMs > 0) {
    timeout = setTimeout(() => abort(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup() {
      if (timeout) clearTimeout(timeout);
      if (parentAbort) parent?.removeEventListener("abort", parentAbort);
    },
  };
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; bytesRead: number; truncated: boolean }> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    const truncated = buffer.byteLength > maxBytes;
    const slice = truncated ? buffer.slice(0, maxBytes) : buffer;
    return { bytes: slice, bytesRead: slice.byteLength, truncated };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - bytesRead;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }

      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        bytesRead += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }

      chunks.push(value);
      bytesRead += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes: merged, bytesRead, truncated };
}

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function htmlToText(html: string): string {
  try {
    const { document } = parseHTML(`<main>${html}</main>`);
    return (document.querySelector("main")?.textContent ?? document.textContent ?? "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  } catch {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}

function maybePrettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function sanitizeFilePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9а-яё._-]+/giu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "content";
}

async function saveTempContent(content: string, format: (typeof outputFormats)[number], titleOrUrl: string) {
  const ext = format === "html" ? "html" : format === "text" ? "txt" : "md";
  const dir = await mkdir(join(tmpdir(), "pi-content-extract"), { recursive: true }).then(() => join(tmpdir(), "pi-content-extract"));
  const filename = `${Date.now()}-${sanitizeFilePart(titleOrUrl)}.${ext}`;
  const path = join(dir, filename);
  await writeFile(path, content, "utf8");
  return path;
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean; omitted: number } {
  if (text.length <= maxChars) return { text, truncated: false, omitted: 0 };
  const omitted = text.length - maxChars;
  return {
    text: `${text.slice(0, maxChars)}\n\n[truncated: ${omitted} chars omitted]`,
    truncated: true,
    omitted,
  };
}

function metadataLines(meta: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`- ${key}: ${String(value)}`);
  }
  return lines;
}

function formatOutput(params: {
  content: string;
  format: (typeof outputFormats)[number];
  metadata: Record<string, unknown>;
  warnings: string[];
}): string {
  const lines: string[] = [];
  lines.push("# Extracted content", "");
  const meta = metadataLines(params.metadata);
  if (meta.length) lines.push(...meta, "");
  for (const warning of params.warnings) lines.push(`- warning: ${warning}`);
  if (params.warnings.length) lines.push("");
  lines.push("---", "");
  lines.push(params.content || "[No content extracted]");
  return lines.join("\n");
}

function isYoutubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)youtube\.com$/i.test(u.hostname) || /(^|\.)youtu\.be$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function resolveLocalPath(path: string, cwd: string): string {
  const normalized = path.startsWith("@") ? path.slice(1) : path;
  return resolve(cwd, normalized);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "extract_content",
    label: "Extract Content",
    description:
      "Load a URL, local HTML/text/PDF file, raw HTML, or raw text and extract clean readable content using Defuddle plus PDF text extraction. Supports articles, docs, Reddit/GitHub/Hacker News/social threads, AI chats, PDFs, and YouTube transcripts when captions are available. Returns Markdown by default. Output is truncated to max_chars; full output is saved to a temp file when truncated.",
    promptSnippet: "Load URLs, HTML, PDFs, or text and extract clean content/metadata with Defuddle, including YouTube transcripts when available.",
    promptGuidelines: [
      "Use extract_content when the user asks to load, read, ingest, scrape, extract, or summarize content from a URL, webpage, article, docs page, PDF, social thread, AI chat, or YouTube video.",
      "extract_content returns extracted content, not a summary; if the user asks for a summary of a URL, first call extract_content and then summarize the returned content.",
      "For YouTube URLs, extract_content should be used for transcript and metadata extraction when captions are available; do not use it to download video or audio media.",
      "When extract_content reports truncation with a temp file path, use the read tool on that path if the full extracted content is needed.",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL to fetch and extract. If no scheme is provided, https:// is assumed." })),
      path: Type.Optional(Type.String({ description: "Local file path to read as HTML/text/PDF. Relative paths are resolved from the current working directory." })),
      html: Type.Optional(Type.String({ description: "Raw HTML string to extract instead of fetching a URL." })),
      text: Type.Optional(Type.String({ description: "Raw plain text to load without Defuddle extraction." })),
      input_type: Type.Optional(StringEnum(inputTypes, { description: "How to interpret input. Default: auto." })),
      output_format: Type.Optional(StringEnum(outputFormats, { description: "Output format. Default: markdown." })),
      language: Type.Optional(Type.String({ description: "Preferred language (BCP 47, e.g. en, ru, ja). Used for Accept-Language and YouTube transcript selection." })),
      include_replies: Type.Optional(StringEnum(replyModes, { description: "Reply/comment extraction mode. Default: extractors." })),
      content_selector: Type.Optional(Type.String({ description: "CSS selector for the main content element; bypasses Defuddle auto-detection if it matches." })),
      remove_images: Type.Optional(Type.Boolean({ description: "Remove images from extracted output. Default: false." })),
      debug: Type.Optional(Type.Boolean({ description: "Enable Defuddle debug output in details." })),
      max_chars: Type.Optional(Type.Integer({ minimum: 2_000, maximum: MAX_MAX_CHARS, description: "Max characters returned to the model. Default: 30000." })),
      max_fetch_bytes: Type.Optional(Type.Integer({ minimum: 100_000, maximum: MAX_FETCH_BYTES, description: "Max response bytes to download from a URL. Default: 8 MiB." })),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 180, description: "Network timeout in seconds. Default: 45." })),
    }),

    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = args as Record<string, unknown>;
      const output: Record<string, unknown> = { ...input };

      if (output.url === undefined) {
        if (typeof input.source === "string") output.url = input.source;
        else if (typeof input.uri === "string") output.url = input.uri;
        else if (typeof input.link === "string") output.url = input.link;
        else if (typeof input.input === "string" && looksLikeUrl(input.input)) output.url = input.input;
      }

      if (output.html === undefined && typeof input.input === "string" && isProbablyHtml(input.input)) output.html = input.input;
      if (output.text === undefined && typeof input.input === "string" && !looksLikeUrl(input.input) && !isProbablyHtml(input.input)) output.text = input.input;
      if (output.output_format === undefined && typeof input.format === "string") output.output_format = input.format;
      if (output.content_selector === undefined && typeof input.selector === "string") output.content_selector = input.selector;

      delete output.source;
      delete output.uri;
      delete output.link;
      delete output.input;
      delete output.format;
      delete output.selector;

      return output;
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const format = normalizeFormat(params.output_format);
      const inputType = normalizeInputType(params.input_type);
      const replyMode = normalizeReplyMode(params.include_replies);
      const maxChars = clampInteger(params.max_chars, DEFAULT_MAX_CHARS, 2_000, MAX_MAX_CHARS);
      const maxFetchBytes = clampInteger(params.max_fetch_bytes, DEFAULT_MAX_FETCH_BYTES, 100_000, MAX_FETCH_BYTES);
      const timeoutSeconds = clampInteger(params.timeout_seconds, DEFAULT_TIMEOUT_SECONDS, 5, 180);
      const language = typeof params.language === "string" && params.language.trim() ? params.language.trim() : undefined;
      const warnings: string[] = [];

      let sourceKind: "url" | "path" | "html" | "text";
      let sourceLabel = "";
      let url: string | undefined;
      let raw = "";
      let rawBytes: Uint8Array | undefined;
      let contentType = "";
      let finalUrl: string | undefined;
      let fetchStatus: number | undefined;
      let fetchBytesRead: number | undefined;
      let fetchTruncated = false;

      if (params.url || inputType === "url") {
        if (!params.url) throw new Error("url is required when input_type is url");
        sourceKind = "url";
        url = normalizeUrl(params.url);
        sourceLabel = url;

        onUpdate?.({
          content: [
            {
              type: "text",
              text: isYoutubeUrl(url) ? `Loading YouTube page/transcript: ${url}` : `Loading page: ${url}`,
            },
          ],
        });

        const timed = createTimedSignal(signal, timeoutSeconds * 1000);
        try {
          const response = await fetch(url, {
            headers: makeHeaders(language),
            redirect: "follow",
            signal: timed.signal,
          });

          fetchStatus = response.status;
          finalUrl = response.url || url;
          contentType = response.headers.get("content-type") ?? "";

          if (!response.ok) {
            return {
              isError: true,
              content: [{ type: "text", text: `Failed to fetch ${url}: HTTP ${response.status} ${response.statusText}` }],
              details: { url, status: response.status, statusText: response.statusText, contentType },
            };
          }

          const body = await readResponseBytes(response, maxFetchBytes);
          fetchBytesRead = body.bytesRead;
          fetchTruncated = body.truncated;
          if (fetchTruncated) warnings.push(`download truncated at ${maxFetchBytes} bytes before extraction`);

          const pathLooksPdf = new URL(finalUrl ?? url).pathname.toLowerCase().endsWith(".pdf");
          if (isPdfContentType(contentType) || pathLooksPdf || looksLikePdfBytes(body.bytes)) {
            rawBytes = body.bytes;
            contentType = contentType || "application/pdf";
          } else {
            raw = decodeBytes(body.bytes);
          }
        } finally {
          timed.cleanup();
        }
      } else if (params.path || inputType === "path") {
        if (!params.path) throw new Error("path is required when input_type is path");
        sourceKind = "path";
        const abs = resolveLocalPath(params.path, ctx.cwd);
        sourceLabel = params.path;
        onUpdate?.({ content: [{ type: "text", text: `Reading local content: ${params.path}` }] });
        const lower = params.path.toLowerCase();
        if (lower.endsWith(".pdf")) {
          rawBytes = await readFile(abs);
          contentType = "application/pdf";
        } else {
          raw = await readFile(abs, "utf8");
          contentType = lower.endsWith(".html") || lower.endsWith(".htm") ? "text/html" : "text/plain";
        }
      } else if (params.html || inputType === "html") {
        if (!params.html) throw new Error("html is required when input_type is html");
        sourceKind = "html";
        sourceLabel = "raw HTML";
        raw = params.html;
        contentType = "text/html";
      } else if (params.text || inputType === "text") {
        if (!params.text) throw new Error("text is required when input_type is text");
        sourceKind = "text";
        sourceLabel = "raw text";
        raw = params.text;
        contentType = "text/plain";
      } else {
        throw new Error("Provide one of: url, path, html, or text");
      }

      if (signal?.aborted) throw new Error("Cancelled");

      let loader: "defuddle" | "pdf" | "raw" = "raw";
      let content = "";
      let metadata: Record<string, unknown> = {
        source: sourceLabel,
        url,
        finalUrl,
        sourceKind,
        format,
      };
      let defuddleResult: any;

      const shouldExtract =
        sourceKind === "html" ||
        isHtmlContentType(contentType) ||
        (sourceKind !== "text" && isProbablyHtml(raw));

      if (rawBytes && (isPdfContentType(contentType) || looksLikePdfBytes(rawBytes))) {
        loader = "pdf";
        onUpdate?.({ content: [{ type: "text", text: "Extracting text from PDF..." }] });

        const parser = new PDFParse({ data: rawBytes });
        let pdfInfo: any;
        try {
          const textResult = await parser.getText();
          pdfInfo = await parser.getInfo().catch(() => undefined);
          content = String(textResult.text ?? "").trim();
          metadata = {
            title: pdfInfo?.info?.Title,
            url,
            finalUrl,
            author: pdfInfo?.info?.Author,
            subject: pdfInfo?.info?.Subject,
            creator: pdfInfo?.info?.Creator,
            producer: pdfInfo?.info?.Producer,
            pages: textResult.total,
            contentType: "application/pdf",
            sourceKind,
            format: "text",
            wordCount: content.trim() ? content.trim().split(/\s+/).length : 0,
          };
        } finally {
          await parser.destroy().catch(() => undefined);
        }
      } else if (shouldExtract) {
        loader = "defuddle";
        onUpdate?.({ content: [{ type: "text", text: "Extracting readable content with Defuddle..." }] });

        const extractionTimed = createTimedSignal(signal, timeoutSeconds * 1000);
        const defuddleFetch: typeof fetch = (input, init = {}) => {
          const headers = mergeHeaders(makeHeaders(language), init.headers);
          return fetch(input, { ...init, headers, signal: init.signal ?? extractionTimed.signal });
        };

        try {
          defuddleResult = await Defuddle(raw, finalUrl ?? url, {
            markdown: format === "markdown",
            url: finalUrl ?? url,
            language,
            includeReplies: includeRepliesValue(replyMode),
            removeImages: params.remove_images === true,
            contentSelector: params.content_selector,
            debug: params.debug === true,
            useAsync: true,
            fetch: defuddleFetch,
          });
        } finally {
          extractionTimed.cleanup();
        }

        content = String(defuddleResult.content ?? "");
        if (format === "text") content = htmlToText(content);

        metadata = {
          title: defuddleResult.title,
          url: url ?? defuddleResult.url,
          finalUrl,
          site: defuddleResult.site,
          domain: defuddleResult.domain,
          author: defuddleResult.author,
          published: defuddleResult.published,
          language: defuddleResult.language,
          description: defuddleResult.description,
          image: defuddleResult.image,
          wordCount: defuddleResult.wordCount,
          parseTimeMs: defuddleResult.parseTime,
          extractorType: defuddleResult.extractorType,
          sourceKind,
          format,
        };
      } else if (isTextLikeContentType(contentType) || sourceKind === "text" || sourceKind === "path") {
        loader = "raw";
        content = /json/i.test(contentType) ? maybePrettyJson(raw) : raw;
        metadata = {
          title: sourceKind === "path" ? params.path : undefined,
          url,
          finalUrl,
          contentType,
          sourceKind,
          format: "text",
          wordCount: content.trim() ? content.trim().split(/\s+/).length : 0,
        };
      } else {
        const message = `Unsupported or non-text content type${contentType ? `: ${contentType}` : ""}. extract_content currently handles HTML, PDF, and text-like responses. Use a dedicated binary/OCR loader for this resource.`;
        return {
          isError: true,
          content: [{ type: "text", text: message }],
          details: { url, finalUrl, contentType, status: fetchStatus, bytesRead: fetchBytesRead },
        };
      }

      if (!content.trim() && loader === "defuddle" && raw.trim()) {
        warnings.push("Defuddle returned empty content; falling back to raw text extracted from HTML");
        content = htmlToText(raw);
        loader = "raw";
      }

      const output = formatOutput({ content, format, metadata, warnings });
      const truncated = truncateText(output, maxChars);
      let fullOutputPath: string | undefined;
      let finalText = truncated.text;

      if (truncated.truncated) {
        fullOutputPath = await saveTempContent(output, format, String(metadata.title || finalUrl || url || sourceLabel));
        finalText += `\n\n[Full extracted output saved to: ${fullOutputPath}]`;
      }

      const debug = params.debug === true && defuddleResult?.debug ? defuddleResult.debug : undefined;

      return {
        content: [{ type: "text", text: finalText }],
        details: {
          loader,
          sourceKind,
          url,
          finalUrl,
          contentType,
          fetch: fetchStatus
            ? {
                status: fetchStatus,
                bytesRead: fetchBytesRead,
                truncated: fetchTruncated,
                maxFetchBytes,
              }
            : undefined,
          metadata,
          contentLength: content.length,
          outputLength: output.length,
          truncated: truncated.truncated,
          omittedChars: truncated.omitted,
          fullOutputPath,
          warnings,
          debug,
          schemaOrgData: params.debug === true ? defuddleResult?.schemaOrgData : undefined,
          metaTags: params.debug === true ? defuddleResult?.metaTags : undefined,
        },
      };
    },
  });
}
