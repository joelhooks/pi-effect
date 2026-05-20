# pi-effect

Pi package for source-first Effect work.

When a repo uses `effect` or `@effect/*`, agents should not vibe-code from stale memory. They should hydrate the official Effect source locally, search it, then write the code.

This package makes that the default instead of a sticky note we hope the agent remembers. 🐀

## What it does

- Detects `effect` / `@effect/*` dependencies in `package.json` files.
- Hydrates the official Effect repo into `.agent-sources/effect/` with a shallow clone.
- Adds `.agent-sources/` to `.git/info/exclude` so the mirror stays out of product commits.
- Injects a source-first Effect rule into Pi's system prompt when the current repo uses Effect.
- Provides an `effect_source` tool for status, hydrate, and source search.
- Provides `/effect-source` for manual operator use.
- Ships a `pi-effect` skill with the same workflow in plain instructions.

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

```bash
/effect-source status
/effect-source hydrate
/effect-source search Effect.fn
```

## Agent tool

The extension registers `effect_source`:

- `status` - report whether the current repo uses Effect and whether the source mirror exists
- `hydrate` - clone `.agent-sources/effect/` if needed and exclude it locally
- `search` - run `rg` against the Effect source mirror

## Source-first repo setup

This package itself is Pi extension code, so Pi source is the source of truth for extension APIs.

Hydrate Pi source locally:

```bash
mkdir -p .agent-source
git clone --depth 1 --filter=blob:none https://github.com/earendil-works/pi-mono.git .agent-source/pi
```

Keep it out of commits:

```bash
printf '%s\n' '.agent-source/' '.agent-sources/' >> .git/info/exclude
```

Do not add those mirrors to `.gitignore` unless we want to make the convention visible to users. For this repo, they are local agent working material.

## Effect source rule

When working in any repo that uses Effect:

1. Check `.agent-sources/effect/`.
2. If missing, shallow clone the official source:

   ```bash
   mkdir -p .agent-sources
   git clone --depth 1 --filter=blob:none https://github.com/effect-ts/effect.git .agent-sources/effect
   ```

3. Add `.agent-sources/` to `.git/info/exclude`.
4. Search `packages/effect/src/`, tests, and examples before claiming anything is an Effect best practice.

## GitHub actor note

Agent-authored GitHub comments and PR reviews should come from [shitratgit[bot]](https://github.com/apps/shitratgit) when the app is installed for the repo owner. Repo creation and the initial push still need a normal GitHub token until ShitRat has installation access.

## Development

```bash
bun run check
npm pack --dry-run
```
