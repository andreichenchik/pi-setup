# Pi-agent note

When expanding pi:

- Do not commit personal information, secrets, tokens, auth files, sessions, machine-local settings, or caches.
- Keep reusable extensions in packages; keep project-specific configuration in project `.pi/settings.json`.

Available custom extensions to enable in a project:

- `~/.pi/agent/packages/custom-tools/extensions/brave-llm-context.ts` — `web_search` tool for Brave web grounding; needs `BRAVE_SEARCH_API_KEY`.
- `~/.pi/agent/packages/custom-tools/extensions/content-extractor.ts` — `extract_content` tool for URLs, HTML/text, PDFs, and YouTube transcripts.
- Enable via project `.pi/settings.json` package source `~/.pi/agent/packages/custom-tools` and the desired `extensions` entries, or with `pi config`.
