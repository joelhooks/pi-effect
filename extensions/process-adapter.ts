import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface GitRootResolution {
  root: string;
  isGitRepo: boolean;
}

export interface SearchProcessResult {
  found: boolean;
  stdout: string;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  cwd: string;
  signal?: AbortSignal;
  maxBytes?: number;
}

export interface SourceProcessAdapter {
  getGitRoot(cwd: string, signal?: AbortSignal): Promise<GitRootResolution>;
  getGitExcludePath(root: string, signal?: AbortSignal): Promise<string>;
  cloneShallow(args: {
    cwd: string;
    repoUrl: string;
    target: string;
    signal?: AbortSignal;
  }): Promise<void>;
  search(args: {
    cwd: string;
    query: string;
    paths: readonly string[];
    globs: readonly string[];
    contextLines: number;
    maxCountPerFile: number;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<SearchProcessResult>;
}

function commandText(command: string, args: readonly string[]) {
  return [command, ...args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg))].join(" ");
}

function commandFailure(command: string, args: readonly string[], result: CommandResult, fallback: string) {
  const output = result.stderr.trim() || result.stdout.trim();
  return new Error(output || `${fallback}: ${commandText(command, args)}`);
}

function run(command: string, args: readonly string[], options: RunOptions) {
  const maxBytes = options.maxBytes ?? 200_000;

  return new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killedBySignal = false;
    let settled = false;

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    };

    const abort = () => {
      killedBySignal = true;
      child.kill("SIGTERM");
    };

    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < maxBytes) stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      if (stderr.length < maxBytes) stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        settleReject(new Error(`Missing command: ${command}`));
        return;
      }
      settleReject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      if (killedBySignal) {
        reject(new Error(`Cancelled: ${commandText(command, args)}`));
        return;
      }
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function createNodeProcessAdapter(): SourceProcessAdapter {
  return {
    async getGitRoot(cwd, signal) {
      const result = await run("git", ["rev-parse", "--show-toplevel"], { cwd, signal }).catch(() => undefined);
      if (!result || result.code !== 0) return { root: cwd, isGitRepo: false };
      return { root: result.stdout.trim(), isGitRepo: true };
    },

    async getGitExcludePath(root, signal) {
      const result = await run("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root, signal });
      if (result.code !== 0) throw commandFailure("git", ["rev-parse", "--git-path", "info/exclude"], result, "Unable to resolve .git/info/exclude");
      return resolve(root, result.stdout.trim());
    },

    async cloneShallow({ cwd, repoUrl, target, signal }) {
      const args = ["clone", "--depth", "1", "--filter=blob:none", repoUrl, target];
      const result = await run("git", args, { cwd, signal, maxBytes: 100_000 });
      if (result.code !== 0) throw commandFailure("git", args, result, "Source clone failed");
    },

    async search({ cwd, query, paths, globs, contextLines, maxCountPerFile, maxBytes, signal }) {
      const args = [
        "--line-number",
        "--context",
        String(contextLines),
        "--max-count",
        String(maxCountPerFile),
        "--",
        query,
        ...paths,
        ...globs.flatMap((glob) => ["-g", glob]),
      ];

      const result = await run("rg", args, { cwd, signal, maxBytes });
      if (result.code === 0) return { found: true, stdout: result.stdout };
      if (result.code === 1) return { found: false, stdout: "" };
      throw commandFailure("rg", args, result, "Effect source search failed");
    },
  };
}
