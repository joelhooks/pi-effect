---
name: pi-effect
description: Enforce source-first Effect work in Pi by finding the project's pinned source mirror, hydrating it when needed, and searching it before making Effect API claims. Use when writing, reviewing, refactoring, or debugging code that imports `effect`, `Effect`, `Schema`, `Layer`, `ServiceMap`, `Config`, or any `@effect/*` package.
---

# Pi Effect

Use this skill for any Effect work. Check the project's source ref first, then use that source before making claims about Effect APIs.

## Required workflow

1. Run `effect_source` with action `status`. It reads the root package plus packages selected by npm, Bun, or pnpm workspace globs. It resolves pnpm `catalog:` entries and skips `.agent-source/`, `.agent-sources/`, and `.agent_sources/` mirrors.
2. Check the expected source ref and warnings. An exact Effect pin resolves to its matching upstream `effect@<version>` tag. A version range can fall back to `main` for v4 or `v3` for v3, but status marks that source as a major-branch fallback, not an exact match. Unresolved aliases such as `latest` cannot choose a source ref.
3. The canonical mirror is `.agent_sources/github.com/Effect-TS/effect/`, with `.agent-source.json` metadata. pi-effect reuses it when the recorded ref and Effect version match. Existing `.agent-sources/effect/` mirrors remain readable as a legacy fallback; no symlink is required.
4. If the matching mirror is missing, run `effect_source` with action `hydrate`. It clones the exact tag or the reported major-branch fallback, writes rat-stack-compatible metadata, and adds the source-mirror paths to `.git/info/exclude`. A stale canonical mirror is left untouched. A stale legacy mirror is preserved while the matching canonical mirror is created beside it.
5. Search the mirror before calling something an Effect best practice:

   ```text
   effect_source action=search query="Effect.fn"
   ```

## If the `effect_source` tool exists

Prefer the tool over hand-rolled commands:

- `status` before editing; distinguish an exact pin from a branch fallback
- `hydrate` when the matching mirror is absent
- `search` for current Effect APIs and patterns; it refuses exact source-version or source-ref mismatches

## What counts as evidence

Prefer, in order:

1. Source in `.agent_sources/github.com/Effect-TS/effect/packages/*/src/`
2. Tests and examples in `.agent_sources/github.com/Effect-TS/effect/packages/`
3. Official Effect docs/examples only when source is not enough
4. Existing repo-local patterns only after checking they are not stale

For a legacy project, use the selected path reported by `effect_source status`. Do not cite old blog posts, memory, or random snippets as best practice when the source is available.
