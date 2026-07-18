import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeProcessAdapter } from "../extensions/process-adapter.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createNodeProcessAdapter", () => {
  test("passes rg globs as options instead of paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-effect-rg-"));
    tempRoots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/match.ts"), "export const needle = true\n", "utf8");
    await writeFile(join(root, "src/ignored.txt"), "needle\n", "utf8");

    const result = await createNodeProcessAdapter().search({
      cwd: root,
      query: "needle",
      paths: ["src"],
      globs: ["*.ts"],
      contextLines: 0,
      maxCountPerFile: 20,
      maxBytes: 50_000,
    });

    expect(result.found).toBe(true);
    expect(result.stdout).toContain("match.ts");
    expect(result.stdout).not.toContain("ignored.txt");
  });
});
