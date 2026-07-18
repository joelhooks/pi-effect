---
name: pi-effect
description: Enforce source-first Effect work in Pi by hydrating and searching the official Effect source. Use when writing, reviewing, refactoring, or debugging code that imports `effect`, `Effect`, `Schema`, `Layer`, `ServiceMap`, `Config`, or any `@effect/*` package.
---

# Pi Effect

Use this skill for any Effect work. The rule is simple: source first, opinions second.

## Required workflow

1. Confirm the current repo uses Effect by checking package/dependency files for `effect` or `@effect/*`. Require an exact Effect version; floating aliases such as `latest` cannot choose a trustworthy source branch offline.
2. Run `effect_source` status and verify the mirror major matches the project. Canonical `main` is Effect v4; Effect v3 lives on the upstream `v3` branch.
3. Check for `.agent-sources/effect/` at the repo root. If missing, hydrate the source mirror:

   ```bash
   mkdir -p .agent-sources
   # Effect v4
   git clone --depth 1 --filter=blob:none --branch main https://github.com/effect-ts/effect.git .agent-sources/effect

   # Effect v3 projects use --branch v3 instead.
   ```

4. Keep the mirror out of product commits:

   ```bash
   printf '%s\n' '.agent-sources/' >> .git/info/exclude
   ```

5. Search the mirror before calling something a best practice:

   ```bash
   rg "Effect.fn" .agent-sources/effect/packages/effect/src .agent-sources/effect/packages -g '*.ts'
   ```

## If the `effect_source` tool exists

Prefer the tool over hand-rolled commands:

- `status` first; stop on a source-major mismatch or unresolved floating spec
- `hydrate` before edits if the mirror is missing
- `search` for current source evidence; it refuses a known source-major mismatch

## What counts as evidence

Prefer, in order:

1. Source in `.agent-sources/effect/packages/*/src/`
2. Tests and examples in `.agent-sources/effect/packages/`
3. Official Effect docs/examples only when source is not enough
4. Existing repo-local patterns only after checking they are not stale

Do not cite old blog posts, memory, or random snippets as best practice when the source is available.
