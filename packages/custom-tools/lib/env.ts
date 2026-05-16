import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_ENV_PATH = join(homedir(), ".pi", "agent", ".env");

function unquote(value: string) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) return trimmed;

  const inner = trimmed.slice(1, -1);
  if (quote === "'") return inner;

  return inner
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function stripInlineComment(value: string) {
  let quote: string | undefined;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const previous = i > 0 ? value[i - 1] : undefined;

    if ((char === '"' || char === "'") && previous !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }

    if (char === "#" && !quote && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
      return value.slice(0, i).trimEnd();
    }
  }

  return value.trimEnd();
}

function readEnvFile(path: string) {
  if (!existsSync(path)) return {};

  const values: Record<string, string> = {};
  const text = readFileSync(path, "utf8");

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    values[key] = unquote(stripInlineComment(rawValue));
  }

  return values;
}

export function readPiEnvValue(name: string, path = DEFAULT_ENV_PATH) {
  const envValue = process.env[name];
  if (envValue !== undefined && envValue !== "") return envValue;

  const fileValue = readEnvFile(path)[name];
  if (fileValue !== undefined && fileValue !== "") return fileValue;

  return undefined;
}
