import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

async function piVersion(pi: ExtensionAPI): Promise<string> {
  const result = await pi.exec("pi", ["--version"], { timeout: 10_000 });
  return result.stdout.trim() || result.stderr.trim() || "unknown";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function resumeCommand(ctx: ExtensionCommandContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  return sessionFile ? `pi --session ${shellQuote(sessionFile)}` : "pi";
}

async function copyToClipboard(pi: ExtensionAPI, text: string): Promise<boolean> {
  const result = await pi.exec("/bin/sh", ["-lc", `printf %s ${shellQuote(text)} | pbcopy`], { timeout: 10_000 });
  return result.code === 0;
}

async function updatePi(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle();

  const before = await piVersion(pi).catch(() => "unknown");
  ctx.ui.notify("Updating Pi with `pi update`...", "info");

  const result = await pi.exec("pi", ["update"], { timeout: 180_000 });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

  if (result.code !== 0) {
    ctx.ui.notify(`Pi update failed.${output ? ` ${output}` : ""}`, "error");
    return;
  }

  const after = await piVersion(pi).catch(() => "unknown");
  const versionChanged = before !== "unknown" && after !== "unknown" && before !== after;
  const versionSummary = versionChanged
    ? `Pi updated: ${before} → ${after}.`
    : `Pi is up to date (${after}).`;

  if (!versionChanged) {
    ctx.ui.notify(versionSummary, "info");
    return;
  }

  const command = resumeCommand(ctx);
  const copied = await copyToClipboard(pi, command).catch(() => false);
  const clipboardSummary = copied ? ` Copied restart command: ${command}` : ` Restart with: ${command}`;

  ctx.ui.notify(`${versionSummary}${clipboardSummary} Exiting Pi now.`, "info");
  ctx.shutdown();
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("update", {
    description: "Update Pi by running `pi update`",
    handler: async (_args, ctx) => {
      await updatePi(pi, ctx);
    },
  });
}
