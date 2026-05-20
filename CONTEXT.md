# pi-effect context

## Domain language

- **Pi Adapter** — the extension-facing module that registers `effect_source`, `/effect-source`, and `before_agent_start` with Pi.
- **Effect source workspace** — the module that owns Effect dependency detection, source mirror status, hydration, search, and repo-root keyed coordination.
- **Source mirror** — a shallow clone of an upstream source repository stored in local agent-only paths such as `.agent-sources/effect/` or `.agent-source/pi/`.
- **Process Adapter** — the module that satisfies the shell/process seam for `git` and `rg` operations, including cancellation, errors, and output limits.
- **Source-first rule** — the policy that agents must search official source before calling something an Effect or Pi best practice.
