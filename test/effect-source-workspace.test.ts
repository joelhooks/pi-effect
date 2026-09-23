import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEffectSourceWorkspace, EFFECT_MIRROR_RELATIVE, LEGACY_EFFECT_MIRROR_RELATIVE } from "../extensions/effect-source-workspace.ts";
import type { SourceProcessAdapter } from "../extensions/process-adapter.ts";

const tempRoots: string[] = [];
const pinnedV4 = "4.0.0-rc.117";

class FakeProcessAdapter implements SourceProcessAdapter {
  readonly cloneCalls: Array<{ cwd: string; ref: string; target: string }> = [];
  readonly searchCalls: Array<{ cwd: string; query: string; paths: readonly string[] }> = [];

  constructor(private readonly isGitRepo = true) {}

  async getGitRoot(cwd: string) {
    return { root: cwd, isGitRepo: this.isGitRepo };
  }

  async getGitExcludePath(root: string) {
    return join(root, ".git/info/exclude");
  }

  async cloneShallow({ cwd, target, ref }: { cwd: string; target: string; ref: string }) {
    this.cloneCalls.push({ cwd, ref, target });
    const version = ref === "v3" ? "3.22.0" : ref === "main" ? pinnedV4 : ref.replace(/^effect@/, "");
    await mkdir(join(cwd, target, "packages/effect/src"), { recursive: true });
    await writeFile(join(cwd, target, "packages/effect/src/Effect.ts"), "export const gen = true\n", "utf8");
    await writeFile(
      join(cwd, target, "packages/effect/package.json"),
      JSON.stringify({ version }),
      "utf8",
    );
    return { commit: "abc123" };
  }

  async search({ cwd, query, paths }: { cwd: string; query: string; paths: readonly string[] }) {
    this.searchCalls.push({ cwd, query, paths });
    return { found: true, stdout: `${paths[0]}:1:export const ${query} = true` };
  }
}

async function createRepo(name: string, packageJson: unknown = { dependencies: { effect: pinnedV4 } }) {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  tempRoots.push(root);
  await mkdir(join(root, ".git/info"), { recursive: true });
  await writeFile(join(root, ".git/info/exclude"), "# local excludes\n", "utf8");
  await writeJson(join(root, "package.json"), packageJson);
  return root;
}

async function writeJson(path: string, value: unknown) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createMirror(root: string, relativePath: string, version: string, ref?: string) {
  const mirror = join(root, relativePath);
  await mkdir(join(mirror, "packages/effect/src"), { recursive: true });
  await writeJson(join(mirror, "packages/effect/package.json"), { name: "effect", version });
  if (ref) {
    await writeJson(join(mirror, ".agent-source.json"), {
      type: "github-repo-source",
      owner: "Effect-TS",
      repo: "effect",
      remote: "https://github.com/Effect-TS/effect.git",
      ref,
      commit: "abc123",
      addedAt: "2026-09-23T00:00:00.000Z",
      note: "test fixture",
    });
  }
  return mirror;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("EffectSourceWorkspace", () => {
  test("hydrates an exact pin from its matching tag and writes rat-stack metadata", async () => {
    const root = await createRepo("pi-effect-exact-pin");
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    await workspace.runAction({ action: "hydrate" }, root);
    const status = await workspace.runAction({ action: "status" }, root);
    const metadata = JSON.parse(await readFile(join(root, EFFECT_MIRROR_RELATIVE, ".agent-source.json"), "utf8"));

    expect(processAdapter.cloneCalls).toEqual([
      { cwd: root, ref: `effect@${pinnedV4}`, target: EFFECT_MIRROR_RELATIVE },
    ]);
    expect(metadata).toMatchObject({
      type: "github-repo-source",
      owner: "Effect-TS",
      repo: "effect",
      ref: `effect@${pinnedV4}`,
      commit: "abc123",
    });
    const exclude = await readFile(join(root, ".git/info/exclude"), "utf8");
    expect(exclude).toContain(".agent_sources/");
    expect(exclude).toContain(".agent-sources/");
    expect(exclude).toContain(".agent-source/");
    expect(status).toContain(`Expected source ref: effect@${pinnedV4} (exact pin)`);
    expect(status).toContain(`Mirror: ${EFFECT_MIRROR_RELATIVE}`);
    expect(status).toContain(`Mirror source ref: effect@${pinnedV4}`);
    expect(status).toContain(`Mirror Effect version: ${pinnedV4}`);
    expect(status).not.toContain("Warning:");
  });

  test("detects pnpm workspace dependencies, resolves catalog pins, and ignores source mirrors", async () => {
    const root = await createRepo("pi-effect-catalog-workspace", {
      private: true,
      workspaces: ["packages/*", ".agent_sources/**", ".agent-sources/**", ".agent-source/**"],
    });
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      [
        "packages:",
        "  - \"packages/*\"",
        "catalog:",
        `  effect: \"${pinnedV4}\"`,
        "catalogs:",
        "  stack:",
        `    \"@effect/platform-node\": \"${pinnedV4}\"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await writeJson(join(root, "packages/core/package.json"), {
      dependencies: { effect: "catalog:", "@effect/platform-node": "catalog:stack" },
    });
    await writeJson(join(root, "outside/package.json"), { dependencies: { effect: "3.22.0" } });
    await writeJson(join(root, ".agent_sources/github.com/Effect-TS/effect/packages/effect/package.json"), {
      dependencies: { effect: "workspace:*" },
    });
    await writeJson(join(root, ".agent-sources/effect/packages/effect/package.json"), {
      dependencies: { effect: "latest" },
    });
    await writeJson(join(root, ".agent-source/pi/package.json"), { dependencies: { effect: "latest" } });

    const workspace = createEffectSourceWorkspace({ processAdapter: new FakeProcessAdapter() });
    const detection = await workspace.detect(root, { refresh: true });

    expect(detection.hits).toHaveLength(2);
    expect(detection.hits.map((hit) => [hit.packagePath, hit.dependency, hit.versionSpec, hit.resolvedVersionSpec])).toEqual([
      ["packages/core/package.json", "effect", "catalog:", pinnedV4],
      ["packages/core/package.json", "@effect/platform-node", "catalog:stack", pinnedV4],
    ]);
  });

  test("detects declared workspace packages outside a git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-effect-no-git-workspace-"));
    tempRoots.push(root);
    await writeJson(join(root, "package.json"), { workspaces: ["packages/*"] });
    await writeJson(join(root, "packages/app/package.json"), { dependencies: { effect: pinnedV4 } });
    const detection = await createEffectSourceWorkspace({ processAdapter: new FakeProcessAdapter(false) }).detect(root, { refresh: true });

    expect(detection.hits).toEqual([
      {
        packagePath: "packages/app/package.json",
        dependency: "effect",
        field: "dependencies",
        versionSpec: pinnedV4,
        resolvedVersionSpec: pinnedV4,
        major: 4,
      },
    ]);
  });

  test("uses a pnpm catalog pin to select the exact source tag", async () => {
    const root = await createRepo("pi-effect-catalog-pin", { dependencies: { effect: "catalog:" } });
    await writeFile(join(root, "pnpm-workspace.yaml"), `catalog:\n  effect: "${pinnedV4}"\n`, "utf8");
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    await workspace.runAction({ action: "hydrate" }, root);

    expect(processAdapter.cloneCalls).toEqual([
      { cwd: root, ref: `effect@${pinnedV4}`, target: EFFECT_MIRROR_RELATIVE },
    ]);
  });

  test("uses one in-flight clone for concurrent hydrate requests", async () => {
    const root = await createRepo("pi-effect-same-root");
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    await Promise.all([
      workspace.runAction({ action: "hydrate" }, root),
      workspace.runAction({ action: "hydrate" }, root),
    ]);

    expect(processAdapter.cloneCalls).toEqual([
      { cwd: root, ref: `effect@${pinnedV4}`, target: EFFECT_MIRROR_RELATIVE },
    ]);
  });

  test("tracks hydration per repo root instead of globally", async () => {
    const firstRoot = await createRepo("pi-effect-first-root");
    const secondRoot = await createRepo("pi-effect-second-root");
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    await Promise.all([
      workspace.runAction({ action: "hydrate" }, firstRoot),
      workspace.runAction({ action: "hydrate" }, secondRoot),
    ]);

    expect(processAdapter.cloneCalls.map(({ cwd }) => cwd).sort()).toEqual([firstRoot, secondRoot].sort());
  });

  test("falls back to the v3 branch for a version range and reports that it is not exact", async () => {
    const root = await createRepo("pi-effect-v3-range", { dependencies: { effect: "^3.22.0" } });
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    await workspace.runAction({ action: "hydrate" }, root);
    const status = await workspace.runAction({ action: "status" }, root);

    expect(processAdapter.cloneCalls).toEqual([
      { cwd: root, ref: "v3", target: EFFECT_MIRROR_RELATIVE },
    ]);
    expect(status).toContain("Expected source ref: v3 (major-branch fallback)");
    expect(status).toContain("No exact Effect version pin was found; using v3 as a v3 branch fallback.");
  });

  test("uses the exact Effect tag for a pinned v3 project", async () => {
    const root = await createRepo("pi-effect-v3-exact", { dependencies: { effect: "3.22.0" } });
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    await workspace.runAction({ action: "hydrate" }, root);
    const status = await workspace.runAction({ action: "status" }, root);

    expect(processAdapter.cloneCalls).toEqual([
      { cwd: root, ref: "effect@3.22.0", target: EFFECT_MIRROR_RELATIVE },
    ]);
    expect(status).toContain("Expected source ref: effect@3.22.0 (exact pin)");
    expect(status).not.toContain("Warning:");
  });

  test("reports fallback to main for a v4 range", async () => {
    const root = await createRepo("pi-effect-v4-range", { dependencies: { effect: "^4.0.0" } });
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    await workspace.runAction({ action: "hydrate" }, root);
    const status = await workspace.runAction({ action: "status" }, root);

    expect(processAdapter.cloneCalls).toEqual([
      { cwd: root, ref: "main", target: EFFECT_MIRROR_RELATIVE },
    ]);
    expect(status).toContain("Expected source ref: main (major-branch fallback)");
    expect(status).toContain("No exact Effect version pin was found; using main as a v4 branch fallback.");
  });

  test("uses a matching rat-stack mirror without cloning a second copy", async () => {
    const root = await createRepo("pi-effect-rat-stack-layout");
    await createMirror(root, EFFECT_MIRROR_RELATIVE, pinnedV4, `effect@${pinnedV4}`);
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    await workspace.runAction({ action: "hydrate" }, root);
    const status = await workspace.runAction({ action: "status" }, root);

    expect(processAdapter.cloneCalls).toEqual([]);
    expect(status).toContain(`Expected source ref: effect@${pinnedV4} (exact pin)`);
    expect(status).toContain(`Mirror: ${EFFECT_MIRROR_RELATIVE}`);
    expect(status).toContain("Mirror layout: rat-stack");
    expect(status).toContain("Mirror ready: yes");
    expect(status).not.toContain("Warning:");
  });

  test("reads a legacy mirror as a fallback", async () => {
    const root = await createRepo("pi-effect-legacy-layout");
    await createMirror(root, LEGACY_EFFECT_MIRROR_RELATIVE, pinnedV4);
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    const output = await workspace.runAction({ action: "search", query: "gen" }, root);
    const status = await workspace.runAction({ action: "status" }, root);

    expect(processAdapter.cloneCalls).toEqual([]);
    expect(processAdapter.searchCalls[0]?.paths[0]).toBe(join(LEGACY_EFFECT_MIRROR_RELATIVE, "packages/effect/src"));
    expect(output).toContain("gen");
    expect(status).toContain(`Mirror: ${LEGACY_EFFECT_MIRROR_RELATIVE}`);
    expect(status).toContain("Mirror layout: legacy");
    expect(status).toContain("Using legacy mirror path");
  });

  test("hydrates a canonical pinned mirror beside a stale legacy mirror without overwriting it", async () => {
    const root = await createRepo("pi-effect-stale-legacy");
    const legacyPath = await createMirror(root, LEGACY_EFFECT_MIRROR_RELATIVE, "4.0.0-rc.116");
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    await workspace.runAction({ action: "hydrate" }, root);
    const status = await workspace.runAction({ action: "status" }, root);

    expect(processAdapter.cloneCalls).toEqual([
      { cwd: root, ref: `effect@${pinnedV4}`, target: EFFECT_MIRROR_RELATIVE },
    ]);
    expect(await Bun.file(join(legacyPath, "packages/effect/package.json")).text()).toContain("4.0.0-rc.116");
    expect(status).toContain(`Mirror: ${EFFECT_MIRROR_RELATIVE}`);
    expect(status).toContain(`Mirror source ref: effect@${pinnedV4}`);
  });

  test("search hydrates a missing source before using the process adapter", async () => {
    const root = await createRepo("pi-effect-search-root");
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    const output = await workspace.runAction({ action: "search", query: "gen" }, root);

    expect(processAdapter.cloneCalls).toEqual([
      { cwd: root, ref: `effect@${pinnedV4}`, target: EFFECT_MIRROR_RELATIVE },
    ]);
    expect(processAdapter.searchCalls).toHaveLength(1);
    expect(processAdapter.searchCalls[0]).toMatchObject({ cwd: root, query: "gen" });
    expect(output).toContain("gen");
  });

  test("refuses to hydrate an unresolved floating latest spec", async () => {
    const root = await createRepo("pi-effect-floating-latest", { dependencies: { effect: "latest" } });
    const workspace = createEffectSourceWorkspace({ processAdapter: new FakeProcessAdapter() });

    await expect(workspace.runAction({ action: "hydrate" }, root)).rejects.toThrow("Cannot resolve an Effect source ref");
    await expect(workspace.runAction({ action: "status" }, root)).resolves.toContain("Cannot resolve an Effect source ref");
  });

  test("refuses to search a mirror from the wrong exact Effect version", async () => {
    const root = await createRepo("pi-effect-version-mismatch");
    await createMirror(root, EFFECT_MIRROR_RELATIVE, "4.0.0-rc.116", "effect@4.0.0-rc.116");
    const workspace = createEffectSourceWorkspace({ processAdapter: new FakeProcessAdapter() });

    await expect(workspace.runAction({ action: "search", query: "gen" }, root)).rejects.toThrow(
      "Effect source version mismatch",
    );
  });

  test("refuses to search a mirror with metadata for the wrong exact tag", async () => {
    const root = await createRepo("pi-effect-ref-mismatch");
    await createMirror(root, EFFECT_MIRROR_RELATIVE, pinnedV4, "effect@4.0.0-rc.116");
    const workspace = createEffectSourceWorkspace({ processAdapter: new FakeProcessAdapter() });

    await expect(workspace.runAction({ action: "search", query: "gen" }, root)).rejects.toThrow(
      "Effect source ref mismatch",
    );
  });

  test("refuses to search a mirror from the wrong Effect major", async () => {
    const root = await createRepo("pi-effect-major-mismatch", { dependencies: { effect: "^3.22.0" } });
    await createMirror(root, EFFECT_MIRROR_RELATIVE, pinnedV4, "effect@4.0.0-rc.117");
    const workspace = createEffectSourceWorkspace({ processAdapter: new FakeProcessAdapter() });

    await expect(workspace.runAction({ action: "search", query: "gen" }, root)).rejects.toThrow(
      "Effect source major mismatch",
    );
  });
});
