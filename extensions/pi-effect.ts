import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const EFFECT_REPO_URL = "https://github.com/effect-ts/effect.git";
const EFFECT_MIRROR_RELATIVE = ".agent-sources/effect";
const EFFECT_EXCLUDE_ENTRY = ".agent-sources/";

const packageDependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const skippedDirectories = new Set([
  ".agent-source",
  ".agent-sources",
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

type EffectAction = "status" | "hydrate" | "search";

interface EffectSourceParams {
  action: EffectAction;
  query?: string;
  force?: boolean;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface DependencyHit {
  packagePath: string;
  dependency: string;
  field: string;
}

interface Detection {
  root: string;
  isGitRepo: boolean;
  hits: DependencyHit[];
}

interface MirrorStatus {
  path: string;
  exists: boolean;
  ready: boolean;
}

const detectionCache = new Map<string, Promise<Detection>>();
let hydratePromise: Promise<void> | undefined;

function commandText(command: string, args: readonly string[]) {
  return [command, ...args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg))].join(" ");
}

function run(command: string, args: readonly string[], options: { cwd: string; signal?: AbortSignal; maxBytes?: number }) {
  const maxBytes = options.maxBytes ?? 200_000;

  return new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killedBySignal = false;

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

    child.on("error", reject);
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (killedBySignal) {
        reject(new Error(`Cancelled: ${commandText(command, args)}`));
        return;
      }
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function pathExists(path: string) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function getGitRoot(cwd: string): Promise<{ root: string; isGitRepo: boolean }> {
  const result = await run("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => undefined);
  if (!result || result.code !== 0) return { root: cwd, isGitRepo: false };
  return { root: result.stdout.trim(), isGitRepo: true };
}

async function getGitExcludePath(root: string) {
  const result = await run("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Unable to resolve .git/info/exclude");
  return resolve(root, result.stdout.trim());
}

async function ensureExcluded(root: string, isGitRepo: boolean) {
  if (!isGitRepo) return undefined;

  const excludePath = await getGitExcludePath(root);
  await mkdir(resolve(excludePath, ".."), { recursive: true });

  const current = (await readFile(excludePath, "utf8").catch(() => ""))
    .split(/\r?\n/)
    .map((line) => line.trim());

  if (!current.includes(EFFECT_EXCLUDE_ENTRY)) {
    await appendFile(excludePath, `${current.length > 0 ? "\n" : ""}${EFFECT_EXCLUDE_ENTRY}\n`, "utf8");
  }

  return excludePath;
}

async function findPackageJsonFiles(root: string, isGitRepo: boolean) {
  if (!isGitRepo) {
    const direct = join(root, "package.json");
    return (await pathExists(direct)) ? [direct] : [];
  }

  const found: string[] = [];
  const maxDepth = 6;
  const maxFiles = 150;

  async function walk(dir: string, depth: number): Promise<void> {
    if (found.length >= maxFiles || depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (skippedDirectories.has(entry.name)) continue;
        await walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name === "package.json") {
        found.push(join(dir, entry.name));
      }
    }
  }

  await walk(root, 0);
  return found;
}

async function detectEffectUsage(cwd: string, refresh = false): Promise<Detection> {
  const { root, isGitRepo } = await getGitRoot(cwd);
  const cacheKey = `${root}:${isGitRepo}`;
  if (!refresh && detectionCache.has(cacheKey)) return detectionCache.get(cacheKey)!;

  const detection = (async () => {
    const packageFiles = await findPackageJsonFiles(root, isGitRepo);
    const hits: DependencyHit[] = [];

    for (const packageFile of packageFiles) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(packageFile, "utf8"));
      } catch {
        continue;
      }

      if (!parsed || typeof parsed !== "object") continue;
      const packageJson = parsed as Record<string, unknown>;

      for (const field of packageDependencyFields) {
        const deps = packageJson[field];
        if (!deps || typeof deps !== "object") continue;

        for (const dependency of Object.keys(deps as Record<string, unknown>)) {
          if (dependency === "effect" || dependency.startsWith("@effect/")) {
            hits.push({
              packagePath: relative(root, packageFile),
              dependency,
              field,
            });
          }
        }
      }
    }

    return { root, isGitRepo, hits };
  })();

  detectionCache.set(cacheKey, detection);
  return detection;
}

async function getMirrorStatus(root: string): Promise<MirrorStatus> {
  const mirrorPath = join(root, EFFECT_MIRROR_RELATIVE);
  const exists = await directoryExists(mirrorPath);
  const ready = exists && (await directoryExists(join(mirrorPath, "packages/effect/src")));
  return { path: mirrorPath, exists, ready };
}

async function hydrateEffectSource(detection: Detection, signal?: AbortSignal) {
  if (hydratePromise) return hydratePromise;

  hydratePromise = (async () => {
    await ensureExcluded(detection.root, detection.isGitRepo);

    const mirror = await getMirrorStatus(detection.root);
    if (mirror.ready) return;
    if (mirror.exists && !mirror.ready) {
      throw new Error(`${EFFECT_MIRROR_RELATIVE} exists but does not look like the Effect repo.`);
    }

    await mkdir(join(detection.root, ".agent-sources"), { recursive: true });
    const clone = await run(
      "git",
      ["clone", "--depth", "1", "--filter=blob:none", EFFECT_REPO_URL, EFFECT_MIRROR_RELATIVE],
      { cwd: detection.root, signal, maxBytes: 100_000 },
    );

    if (clone.code !== 0) {
      throw new Error(clone.stderr.trim() || clone.stdout.trim() || "Effect source clone failed");
    }
  })().finally(() => {
    hydratePromise = undefined;
  });

  return hydratePromise;
}

function formatDependencyHits(hits: DependencyHit[]) {
  if (hits.length === 0) return "No Effect dependencies found.";
  return hits.map((hit) => `- ${hit.packagePath}: ${hit.field}.${hit.dependency}`).join("\n");
}

async function statusText(detection: Detection) {
  const mirror = await getMirrorStatus(detection.root);
  return [
    `Repo root: ${detection.root}`,
    `Uses Effect: ${detection.hits.length > 0 ? "yes" : "no"}`,
    "",
    formatDependencyHits(detection.hits),
    "",
    `Mirror: ${relative(detection.root, mirror.path)}`,
    `Mirror exists: ${mirror.exists ? "yes" : "no"}`,
    `Mirror ready: ${mirror.ready ? "yes" : "no"}`,
  ].join("\n");
}

async function searchEffectSource(detection: Detection, query: string, signal?: AbortSignal) {
  const mirror = await getMirrorStatus(detection.root);
  if (!mirror.ready) {
    await hydrateEffectSource(detection, signal);
  }

  const search = await run(
    "rg",
    [
      "--line-number",
      "--context",
      "2",
      "--max-count",
      "20",
      query,
      join(EFFECT_MIRROR_RELATIVE, "packages/effect/src"),
      join(EFFECT_MIRROR_RELATIVE, "packages"),
      "-g",
      "*.ts",
      "-g",
      "*.md",
      "-g",
      "!**/node_modules/**",
    ],
    { cwd: detection.root, signal, maxBytes: 50_000 },
  );

  if (search.code === 0) return search.stdout.trim() || "No matches.";
  if (search.code === 1) return "No matches.";
  throw new Error(search.stderr.trim() || "Effect source search failed");
}

async function runEffectSourceAction(params: EffectSourceParams, ctx: ExtensionContext, signal?: AbortSignal) {
  const detection = await detectEffectUsage(ctx.cwd, true);

  if (params.action === "status") {
    return statusText(detection);
  }

  if (params.action === "hydrate") {
    if (detection.hits.length === 0 && !params.force) {
      return `${await statusText(detection)}\n\nSkipped hydrate because no Effect dependency was found. Pass force=true if this repo is weird.`;
    }

    await hydrateEffectSource(detection, signal);
    return `${await statusText(detection)}\n\nHydrated Effect source mirror.`;
  }

  if (params.action === "search") {
    const query = params.query?.trim();
    if (!query) throw new Error("effect_source search requires query.");
    if (detection.hits.length === 0 && !params.force) {
      return `${await statusText(detection)}\n\nSkipped search because no Effect dependency was found. Pass force=true if this repo is weird.`;
    }

    return searchEffectSource(detection, query, signal);
  }

  throw new Error(`Unknown effect_source action: ${params.action satisfies never}`);
}

function parseCommandArgs(args: string): EffectSourceParams {
  const trimmed = args.trim();
  if (!trimmed) return { action: "status" };

  const [action, ...rest] = trimmed.split(/\s+/);
  if (action === "status" || action === "hydrate") return { action };
  if (action === "search") return { action, query: rest.join(" ") };

  return { action: "search", query: trimmed };
}

function effectSourceRule(mirrorRelative: string) {
  return `

# Effect source rule (pi-effect)

This repo uses Effect. Before writing, reviewing, or refactoring Effect code, reference the official Effect source mirror at \`${mirrorRelative}\`. If the mirror is missing, use the \`effect_source\` tool with action \`hydrate\` first. Search source, tests, and examples before calling anything an Effect best practice. Do not rely on stale memory or blog snippets.
`;
}

export default function piEffectExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "effect_source",
    label: "Effect Source",
    description: "Detect Effect dependencies, hydrate the official Effect source mirror, and search it for source-grounded best practices.",
    promptSnippet: "Detect, hydrate, and search official Effect source in repos that use Effect.",
    promptGuidelines: [
      "Use effect_source with action `status` when entering an unfamiliar repo that may use Effect.",
      "Use effect_source with action `hydrate` before writing, reviewing, or refactoring Effect code if `.agent-sources/effect/` is missing.",
      "Use effect_source with action `search` to verify current Effect APIs and patterns before calling something an Effect best practice.",
    ],
    parameters: Type.Object({
      action: StringEnum(["status", "hydrate", "search"] as const),
      query: Type.Optional(Type.String({ description: "Search query for action=search." })),
      force: Type.Optional(Type.Boolean({ description: "Run even when package.json detection does not find Effect." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: `effect_source ${params.action}...` }] });
      const text = await runEffectSourceAction(params as EffectSourceParams, ctx, signal);
      return {
        content: [{ type: "text", text }],
        details: { action: params.action },
      };
    },
  });

  pi.registerCommand("effect-source", {
    description: "Status, hydrate, or search the official Effect source mirror",
    getArgumentCompletions: (prefix) => {
      const commands = ["status", "hydrate", "search"];
      const filtered = commands.filter((command) => command.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((command) => ({ value: command, label: command })) : null;
    },
    handler: async (args, ctx) => {
      const params = parseCommandArgs(args);
      const text = await runEffectSourceAction(params, ctx, ctx.signal);
      pi.sendMessage({
        customType: "pi-effect",
        content: text,
        display: true,
        details: { action: params.action },
      });
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const detection = await detectEffectUsage(ctx.cwd);
    if (detection.hits.length === 0) return;

    let hydrationNote = "";
    const mirror = await getMirrorStatus(detection.root);
    if (!mirror.ready) {
      try {
        await hydrateEffectSource(detection, ctx.signal);
        hydrationNote = "\n\npi-effect already hydrated `.agent-sources/effect/` for this repo.";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        hydrationNote = `\n\npi-effect tried to hydrate \`.agent-sources/effect/\` but failed: ${message}`;
      }
    }

    return {
      systemPrompt: `${event.systemPrompt}${effectSourceRule(EFFECT_MIRROR_RELATIVE)}${hydrationNote}`,
    };
  });
}
