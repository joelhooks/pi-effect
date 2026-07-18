import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEffectSourceWorkspace } from "../extensions/effect-source-workspace.ts";
import type { SourceProcessAdapter } from "../extensions/process-adapter.ts";

const tempRoots: string[] = [];

class FakeProcessAdapter implements SourceProcessAdapter {
  readonly cloneCalls: Array<{ cwd: string; branch: string }> = [];
  readonly searchCalls: Array<{ cwd: string; query: string; paths: readonly string[] }> = [];

  async getGitRoot(cwd: string) {
    return { root: cwd, isGitRepo: true };
  }

  async getGitExcludePath(root: string) {
    return join(root, ".git/info/exclude");
  }

  async cloneShallow({ cwd, target, branch }: { cwd: string; target: string; branch: string }) {
    this.cloneCalls.push({ cwd, branch });
    await mkdir(join(cwd, target, "packages/effect/src"), { recursive: true });
    await writeFile(join(cwd, target, "packages/effect/src/Effect.ts"), "export const gen = true\n", "utf8");
    await writeFile(
      join(cwd, target, "packages/effect/package.json"),
      JSON.stringify({ version: branch === "v3" ? "3.22.0" : "4.0.0-beta.99" }),
      "utf8",
    );
  }

  async search({ cwd, query, paths }: { cwd: string; query: string; paths: readonly string[] }) {
    this.searchCalls.push({ cwd, query, paths });
    return { found: true, stdout: `${paths[0]}:1:export const ${query} = true` };
  }
}

async function createEffectRepo(name: string) {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  tempRoots.push(root);
  await mkdir(join(root, ".git/info"), { recursive: true });
  await writeFile(join(root, ".git/info/exclude"), "# local excludes\n", "utf8");
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { effect: "4.0.0-beta.99" } }), "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("EffectSourceWorkspace", () => {
  test("hydrates a root through one in-flight clone", async () => {
    const root = await createEffectRepo("pi-effect-same-root");
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    await Promise.all([
      workspace.runAction({ action: "hydrate" }, root),
      workspace.runAction({ action: "hydrate" }, root),
    ]);

    expect(processAdapter.cloneCalls).toEqual([{ cwd: root, branch: "main" }]);
  });

  test("tracks hydration per repo root instead of globally", async () => {
    const firstRoot = await createEffectRepo("pi-effect-first-root");
    const secondRoot = await createEffectRepo("pi-effect-second-root");
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    await Promise.all([
      workspace.runAction({ action: "hydrate" }, firstRoot),
      workspace.runAction({ action: "hydrate" }, secondRoot),
    ]);

    expect(processAdapter.cloneCalls.map(({ cwd }) => cwd).sort()).toEqual([firstRoot, secondRoot].sort());
  });

  test("search hydrates missing source before using the process adapter", async () => {
    const root = await createEffectRepo("pi-effect-search-root");
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    const output = await workspace.runAction({ action: "search", query: "gen" }, root);

    expect(processAdapter.cloneCalls).toEqual([{ cwd: root, branch: "main" }]);
    expect(processAdapter.searchCalls).toHaveLength(1);
    expect(processAdapter.searchCalls[0]).toMatchObject({ cwd: root, query: "gen" });
    expect(output).toContain("gen");
  });

  test("hydrates the v3 branch for an explicit v3 project", async () => {
    const root = await createEffectRepo("pi-effect-v3-root");
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { effect: "^3.22.0" } }), "utf8");
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    await workspace.runAction({ action: "hydrate" }, root);

    expect(processAdapter.cloneCalls).toEqual([{ cwd: root, branch: "v3" }]);
  });

  test("reports the dependency spec and mirror version", async () => {
    const root = await createEffectRepo("pi-effect-version-status");
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    await workspace.runAction({ action: "hydrate" }, root);
    const output = await workspace.runAction({ action: "status" }, root);

    expect(output).toContain("effect (dependencies): 4.0.0-beta.99");
    expect(output).toContain("Mirror Effect version: 4.0.0-beta.99");
  });

  test("refuses to hydrate an unresolved floating latest spec", async () => {
    const root = await createEffectRepo("pi-effect-floating-latest");
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { effect: "latest" } }), "utf8");
    const workspace = createEffectSourceWorkspace({ processAdapter: new FakeProcessAdapter() });

    await expect(workspace.runAction({ action: "hydrate" }, root)).rejects.toThrow(
      "Cannot resolve the Effect source branch",
    );
  });

  test("refuses to search a mirror from the wrong exact Effect version", async () => {
    const root = await createEffectRepo("pi-effect-version-mismatch");
    await mkdir(join(root, ".agent-sources/effect/packages/effect/src"), { recursive: true });
    await writeFile(join(root, ".agent-sources/effect/packages/effect/package.json"), JSON.stringify({ version: "4.0.0-beta.98" }), "utf8");
    const workspace = createEffectSourceWorkspace({ processAdapter: new FakeProcessAdapter() });

    await expect(workspace.runAction({ action: "search", query: "gen" }, root)).rejects.toThrow(
      "Effect source version mismatch",
    );
  });

  test("refuses to search a mirror from the wrong Effect major", async () => {
    const root = await createEffectRepo("pi-effect-major-mismatch");
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { effect: "^3.22.0" } }), "utf8");
    await mkdir(join(root, ".agent-sources/effect/packages/effect/src"), { recursive: true });
    await writeFile(join(root, ".agent-sources/effect/packages/effect/package.json"), JSON.stringify({ version: "4.0.0-beta.99" }), "utf8");
    const workspace = createEffectSourceWorkspace({ processAdapter: new FakeProcessAdapter() });

    await expect(workspace.runAction({ action: "search", query: "gen" }, root)).rejects.toThrow(
      "Effect source major mismatch",
    );
  });
});
