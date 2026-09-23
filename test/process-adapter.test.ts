import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeProcessAdapter } from "../extensions/process-adapter.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createNodeProcessAdapter", () => {
  test("clones the requested exact tag and returns its commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-effect-clone-tag-"));
    tempRoots.push(root);
    const source = join(root, "upstream");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "source.txt"), "pinned source\n", "utf8");
    execFileSync("git", ["init", "--quiet"], { cwd: source });
    execFileSync("git", ["add", "source.txt"], { cwd: source });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "source"], { cwd: source });
    execFileSync("git", ["tag", "effect@4.0.0-rc.117"], { cwd: source });

    const result = await createNodeProcessAdapter().cloneShallow({
      cwd: root,
      repoUrl: source,
      target: "mirror",
      ref: "effect@4.0.0-rc.117",
    });
    const expectedCommit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    expect(result.commit).toBe(expectedCommit);
    expect(await Bun.file(join(root, "mirror/source.txt")).text()).toBe("pinned source\n");
  }, 30_000);

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
