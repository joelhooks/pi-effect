# pi-effect context

## Domain language

- **Pi Adapter** — the extension-facing module that registers `effect_source`, `/effect-source`, and `before_agent_start` with Pi.
- **Effect source workspace** — the module that owns Effect dependency detection across declared workspaces, pnpm catalog resolution, source mirror status, hydration, search, and repo-root keyed coordination.
- **Source mirror** — a shallow clone of an upstream source repository stored in a local agent-only path. For Effect, `.agent_sources/github.com/Effect-TS/effect/` is canonical; `.agent-sources/effect/` remains a read fallback for existing projects.
- **Source mirror metadata** — `.agent-source.json` records the upstream repo, ref, and commit for a rat-stack-compatible source mirror.
- **Exact source ref** — the `effect@<version>` upstream tag derived from an exact Effect dependency pin. `main` and `v3` are major-branch fallbacks, not exact version matches.
- **Process Adapter** — the module that satisfies the shell/process seam for `git` and `rg` operations, including cancellation, errors, and output limits.
- **Source-first rule** — the policy that agents must check the project's source ref and search official source before calling something an Effect best practice.
