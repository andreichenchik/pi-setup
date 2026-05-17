# Container-agent note

You are running inside a devcontainer with a container-local Pi config copied from the host snapshot.

- Treat the active Pi config directory as container-local runtime state.
- Keep sessions in the project-local directory configured by `PI_CODING_AGENT_SESSION_DIR`.
- Do not write secrets, auth files, machine-local settings, sessions, or caches into the workspace unless explicitly requested.
- Host Pi setup changes must be made outside the devcontainer, then committed and copied into a fresh snapshot.
- Pi extensions created or changed inside the devcontainer are ephemeral and will be overwritten when the container is recreated.
