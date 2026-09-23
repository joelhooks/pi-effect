# pi-effect

Pi package for source-first Effect work.

When a repo uses `effect` or `@effect/*`, agents should not vibe-code from stale memory. They should verify the project's source ref, search the matching Effect source, then write the code.

## What it does

- Detects `effect` / `@effect/*` dependencies in the root package and declared npm, Bun, or pnpm workspace packages. It resolves pnpm `catalog:` pins and ignores source mirrors.
- Reuses the rat-stack source mirror at `.agent_sources/github.com/Effect-TS/effect/`, including its `.agent-source.json` ref metadata.
- Hydrates an exact Effect pin from the matching `effect@<version>` tag. If the project has only a version range, it falls back to `main` for v4 or `v3` for v3 and reports that the source is not an exact match. Unresolved aliases such as `latest` cannot select a source ref.
- Reads the legacy `.agent-sources/effect/` layout when the canonical mirror is absent. If that legacy source is stale for the project pin, it creates a canonical copy beside it and leaves the old mirror untouched.
- Adds `.agent-source/`, `.agent-sources/`, and `.agent_sources/` to `.git/info/exclude` so local source mirrors stay out of product commits.
- Injects a source-first Effect rule into Pi's system prompt when the current repo uses Effect.
- Provides an `effect_source` tool for status, hydrate, and source search, plus `/effect-source` for manual operator use.

## Install

Local dev:

```bash
pi install /Users/joel/Code/joelhooks/pi-effect
```

From GitHub once pushed:

```bash
pi install git:github.com/joelhooks/pi-effect
```

## Commands

```text
/effect-source status
/effect-source hydrate
/effect-source search Effect.fn
```

The status output reports the expected source ref, whether it came from an exact pin or a major-branch fallback, the selected mirror layout, mirror metadata, and the Effect package version. A source-ref or version mismatch blocks search. Hydration does not overwrite an existing mirror.

## Agent tool

The extension registers `effect_source`:

- `status` - report project dependency specs, expected source ref, exact/fallback mode, mirror readiness, metadata ref, and Effect version
- `hydrate` - reuse a matching mirror or shallow-clone the project's exact `effect@<version>` tag into `.agent_sources/github.com/Effect-TS/effect/`; branch fallbacks are reported
- `search` - run `rg` against the selected Effect source mirror and reject stale exact-version or source-ref mismatches

## Source mirrors in this repo

This package itself is Pi extension code, so Pi source is the source of truth for extension APIs.

Hydrate Pi source locally:

```bash
mkdir -p .agent-source
git clone --depth 1 --filter=blob:none https://github.com/earendil-works/pi-mono.git .agent-source/pi
```

Keep it and the Effect mirror out of commits:

```bash
printf '%s\n' '.agent-source/' '.agent-sources/' '.agent_sources/' >> .git/info/exclude
```

Do not add those mirrors to `.gitignore` unless we want to make the convention visible to users. They are local agent working material.

## Effect source workflow

1. Run `effect_source` with action `status` and check the dependency spec, expected ref, mirror metadata, and any warning.
2. Exact pins use the matching upstream tag, such as `effect@4.0.0-rc.117`. If the project has a range, pi-effect may use `main` or `v3` as a major-only fallback; status says this is not an exact match. Floating aliases with no detectable major are unresolved.
3. Use action `hydrate` if the matching mirror is missing. pi-effect writes the same `.agent-source.json` metadata rat-stack writes. A stale or conflicting mirror is left untouched and reported.
4. Search source, tests, and examples before calling anything an Effect best practice.

## GitHub actor note

Agent-authored GitHub commits, issue comments, and PR reviews should come from [shitratgit[bot]](https://github.com/apps/shitratgit) when the app is installed for the repo owner. For small agent-authored repo edits, use `shitrat commit-file` or `shitrat commit-files` instead of local `git commit && git push`.

## Architecture

- `extensions/pi-effect.ts` is the Pi Adapter. It registers the tool, command, and prompt injection.
- `extensions/effect-source-workspace.ts` owns Effect dependency detection, workspace and catalog resolution, mirror status, hydration, search, and repo-root keyed coordination.
- `extensions/process-adapter.ts` is the Process Adapter seam for `git` and `rg` operations.

## Development

```bash
bun run check
npm pack --dry-run
```
