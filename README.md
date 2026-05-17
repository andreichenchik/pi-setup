# Pi Setup

Personal `~/.pi/agent` setup for Pi.

This repo stores only shareable configuration and code. Machine-local files, secrets, generated files, and caches are ignored by git:

- `.env`
- `auth.json`
- `settings.json`
- `models.json`
- `AGENTS.md`
- `sessions/`
- `git/`, `npm/`, `bin/`, `node_modules/`

## Agent instructions

Host `AGENTS.md` is generated and should not be edited directly. Update these source fragments instead:

- `AGENTS-PI.md` — host Pi-specific rules.
- `AGENTS-CONTAINER.md` — rules that should appear first inside generated devcontainer snapshots.
- `~/.config/agents/AGENTS.md` — optional shared/global rules appended after Pi fragments when the file exists.

Refresh host instructions with:

```bash
~/.pi/agent/refresh-agents.md.sh
```

If the global shared file does not exist, the generated host `AGENTS.md` contains only `AGENTS-PI.md`.

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

## Devcontainer snapshot

To run Pi inside devcontainers without mounting the real `~/.pi/agent` writable, generate a container snapshot:

```bash
~/.pi/agent/pi-container-copy.sh
```

The script uses committed files from this repo, so commit or stash changes before running it. It writes to:

```text
~/.pi/container-agent
```

In the snapshot, `AGENTS.md` is generated from `AGENTS-CONTAINER.md`, then `AGENTS-PI.md`, then optional `~/.config/agents/AGENTS.md` when it exists.

Use the snapshot in `.devcontainer/devcontainer.json` as a read-only mount, then run the setup script on create:

```json
{
  "mounts": [
    "source=${localEnv:HOME}/.pi/container-agent,target=/mnt/pi-container-agent,type=bind,readonly"
  ],
  "containerEnv": {
    "PI_CODING_AGENT_SESSION_DIR": "/workspace/.pi/sessions"
  },
  "postCreateCommand": "/mnt/pi-container-agent/devcontainer-setup.sh"
}
```

The setup script copies the read-only snapshot to a writable `~/.pi/agent`, installs `pnpm` when needed, adds `$PNPM_HOME/bin` to `~/.bashrc`, installs `@earendil-works/pi-coding-agent` globally, and installs production pnpm modules for the copied agent setup.

This keeps host Pi config separate from container-local writes. Sessions are stored in the project-local `.pi/sessions` directory.
