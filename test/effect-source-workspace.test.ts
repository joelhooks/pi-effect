import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEffectSourceWorkspace } from "../extensions/effect-source-workspace.ts";
import type { SourceProcessAdapter } from "../extensions/process-adapter.ts";

const tempRoots: string[] = [];

class FakeProcessAdapter implements SourceProcessAdapter {
  readonly cloneCalls: string[] = [];
  readonly searchCalls: Array<{ cwd: string; query: string; paths: readonly string[] }> = [];

  async getGitRoot(cwd: string) {
    return { root: cwd, isGitRepo: true };
  }

  async getGitExcludePath(root: string) {
    return join(root, ".git/info/exclude");
  }

  async cloneShallow({ cwd, target }: { cwd: string; target: string }) {
    this.cloneCalls.push(cwd);
    await mkdir(join(cwd, target, "packages/effect/src"), { recursive: true });
    await writeFile(join(cwd, target, "packages/effect/src/Effect.ts"), "export const gen = true\n", "utf8");
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
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { effect: "latest" } }), "utf8");
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

    expect(processAdapter.cloneCalls).toEqual([root]);
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

    expect(processAdapter.cloneCalls.sort()).toEqual([firstRoot, secondRoot].sort());
  });

  test("search hydrates missing source before using the process adapter", async () => {
    const root = await createEffectRepo("pi-effect-search-root");
    const processAdapter = new FakeProcessAdapter();
    const workspace = createEffectSourceWorkspace({ processAdapter });

    const output = await workspace.runAction({ action: "search", query: "gen" }, root);

    expect(processAdapter.cloneCalls).toEqual([root]);
    expect(processAdapter.searchCalls).toHaveLength(1);
    expect(processAdapter.searchCalls[0]).toMatchObject({ cwd: root, query: "gen" });
    expect(output).toContain("gen");
  });
});
