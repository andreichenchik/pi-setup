# Pi container-agent snapshot

This directory is generated from committed `~/.pi/agent` contents by `pi-container-copy.sh`. The script refuses to run with uncommitted host config changes.

It is intended to be mounted read-only into devcontainers, then installed with `devcontainer-setup.sh` into a writable per-container Pi config directory.

Generated files should not be edited directly. Update the source files in `~/.pi/agent`, commit the changes, and rerun the copy script. Pi extensions created or changed inside a devcontainer are ephemeral and will be overwritten when the container is recreated.

The snapshot contains:

- committed public Pi setup files from `~/.pi/agent`;
- selected local runtime files: `.env`, `auth.json`, `settings.json`, `models.json` when present;
- host `README.md` preserved as `README-HOST.md`;
- `README-CONTAINER.md` moved to `README.md`;
- `AGENTS.md` generated from `AGENTS-CONTAINER.md`, `AGENTS-PI.md`, and optional `~/.config/agents/AGENTS.md`.

Run `/mnt/pi-container-agent/devcontainer-setup.sh` from the devcontainer. It copies this snapshot to `~/.pi/agent`, installs `pnpm` when needed, adds `$PNPM_HOME/bin` to `~/.bashrc`, installs `@earendil-works/pi-coding-agent` globally, and installs production pnpm modules for the copied agent setup.

Sessions should stay outside this snapshot via `PI_CODING_AGENT_SESSION_DIR`.
