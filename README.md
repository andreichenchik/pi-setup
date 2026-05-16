# Pi Setup

Personal `~/.pi/agent` setup for Pi.

This repo stores only shareable configuration and code. Machine-local files and secrets are ignored by git:

- `.env`
- `auth.json`
- `settings.json`
- `sessions/`
- `git/`, `npm/`, `bin/`, `node_modules/`

## Environment variables

Copy the example file and fill in keys:

```bash
cp ~/.pi/agent/.env.example ~/.pi/agent/.env
```

Pi does not load `.env` files automatically. Tools that need secrets should read `process.env` first and then fall back to `~/.pi/agent/.env`.

`packages/custom-tools/lib/env.ts` contains the shared helper for that pattern.

## Custom tools package

Reusable tools live in:

```text
packages/custom-tools/
```

It is a Pi package with these extensions:

- `extensions/brave-llm-context.ts`
- `extensions/content-extractor.ts`

Install package dependencies after cloning or changing dependencies:

```bash
pnpm install --prod
# or
pnpm run install:custom-tools
```

## Enable custom tools per project

In a project, add `.pi/settings.json`:

```json
{
  "packages": [
    {
      "source": "~/.pi/agent/packages/custom-tools",
      "extensions": [
        "extensions/brave-llm-context.ts",
        "extensions/content-extractor.ts"
      ]
    }
  ]
}
```

Enable only one tool:

```json
{
  "packages": [
    {
      "source": "~/.pi/agent/packages/custom-tools",
      "extensions": ["extensions/content-extractor.ts"]
    }
  ]
}
```

Enable all except one:

```json
{
  "packages": [
    {
      "source": "~/.pi/agent/packages/custom-tools",
      "extensions": ["extensions/*.ts", "!extensions/brave-llm-context.ts"]
    }
  ]
}
```

You can also use:

```bash
pi config
```

Then toggle resources in the TUI.
