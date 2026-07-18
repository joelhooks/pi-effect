import { constants } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createNodeProcessAdapter, type SourceProcessAdapter } from "./process-adapter.ts";

export const EFFECT_REPO_URL = "https://github.com/effect-ts/effect.git";
export const EFFECT_MIRROR_RELATIVE = ".agent-sources/effect";
export const EFFECT_EXCLUDE_ENTRY = ".agent-sources/";

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

export type EffectAction = "status" | "hydrate" | "search";

export interface EffectSourceParams {
  action: EffectAction;
  query?: string;
  force?: boolean;
}

export type EffectMajor = 3 | 4;

export interface DependencyHit {
  packagePath: string;
  dependency: string;
  field: string;
  versionSpec: string;
  major: EffectMajor | undefined;
}

export interface Detection {
  root: string;
  isGitRepo: boolean;
  hits: DependencyHit[];
}

export interface MirrorStatus {
  path: string;
  exists: boolean;
  ready: boolean;
  effectVersion: string | undefined;
  major: EffectMajor | undefined;
}

interface DetectOptions {
  refresh?: boolean;
  signal?: AbortSignal;
}

interface WorkspaceOptions {
  processAdapter?: SourceProcessAdapter;
  effectRepoUrl?: string;
  mirrorRelative?: string;
  excludeEntry?: string;
}

export class EffectSourceWorkspace {
  private readonly processAdapter: SourceProcessAdapter;
  private readonly effectRepoUrl: string;
  private readonly mirrorRelative: string;
  private readonly excludeEntry: string;
  private readonly detectionCache = new Map<string, Promise<Detection>>();
  private readonly hydrationByRoot = new Map<string, Promise<void>>();

  constructor(options: WorkspaceOptions = {}) {
    this.processAdapter = options.processAdapter ?? createNodeProcessAdapter();
    this.effectRepoUrl = options.effectRepoUrl ?? EFFECT_REPO_URL;
    this.mirrorRelative = options.mirrorRelative ?? EFFECT_MIRROR_RELATIVE;
    this.excludeEntry = options.excludeEntry ?? EFFECT_EXCLUDE_ENTRY;
  }

  async detect(cwd: string, options: DetectOptions = {}): Promise<Detection> {
    const { root, isGitRepo } = await this.processAdapter.getGitRoot(cwd, options.signal);
    const cacheKey = `${root}:${isGitRepo}`;
    if (!options.refresh && this.detectionCache.has(cacheKey)) return this.detectionCache.get(cacheKey)!;

    const detection = this.createDetection(root, isGitRepo);
    this.detectionCache.set(cacheKey, detection);
    return detection;
  }

  async mirrorStatus(root: string): Promise<MirrorStatus> {
    const mirrorPath = join(root, this.mirrorRelative);
    const exists = await directoryExists(mirrorPath);
    const ready = exists && (await directoryExists(join(mirrorPath, "packages/effect/src")));
    const effectVersion = ready
      ? await readPackageVersion(join(mirrorPath, "packages/effect/package.json"))
      : undefined;
    return {
      path: mirrorPath,
      exists,
      ready,
      effectVersion,
      major: effectVersion ? effectMajorFromVersionSpec(effectVersion) : undefined,
    };
  }

  async hydrate(detection: Detection, signal?: AbortSignal) {
    const inFlight = this.hydrationByRoot.get(detection.root);
    if (inFlight) return inFlight;

    const hydrate = this.hydrateRoot(detection, signal).finally(() => {
      this.hydrationByRoot.delete(detection.root);
    });

    this.hydrationByRoot.set(detection.root, hydrate);
    return hydrate;
  }

  async statusText(detection: Detection) {
    const mirror = await this.mirrorStatus(detection.root);
    const warning = sourceVersionWarning(detection, mirror);
    return [
      `Repo root: ${detection.root}`,
      `Uses Effect: ${detection.hits.length > 0 ? "yes" : "no"}`,
      `Expected source branch: ${sourceBranchFor(detection) ?? "unknown"}`,
      "",
      formatDependencyHits(detection.hits),
      "",
      `Mirror: ${relative(detection.root, mirror.path)}`,
      `Mirror exists: ${mirror.exists ? "yes" : "no"}`,
      `Mirror ready: ${mirror.ready ? "yes" : "no"}`,
      `Mirror Effect version: ${mirror.effectVersion ?? "unknown"}`,
      ...(warning ? ["", `Warning: ${warning}`] : []),
    ].join("\n");
  }

  async search(detection: Detection, query: string, signal?: AbortSignal) {
    let mirror = await this.mirrorStatus(detection.root);
    if (!mirror.ready) {
      await this.hydrate(detection, signal);
      mirror = await this.mirrorStatus(detection.root);
    }

    const warning = sourceVersionWarning(detection, mirror);
    if (
      warning?.startsWith("Effect source major mismatch") ||
      warning?.startsWith("Effect source version mismatch") ||
      warning?.startsWith("Cannot resolve the Effect source branch")
    ) {
      throw new Error(warning);
    }

    const result = await this.processAdapter.search({
      cwd: detection.root,
      query,
      paths: [
        join(this.mirrorRelative, "packages/effect/src"),
        join(this.mirrorRelative, "packages"),
      ],
      globs: ["*.ts", "*.md", "!**/node_modules/**"],
      contextLines: 2,
      maxCountPerFile: 20,
      maxBytes: 50_000,
      signal,
    });

    return result.found ? result.stdout.trim() || "No matches." : "No matches.";
  }

  async runAction(params: EffectSourceParams, cwd: string, signal?: AbortSignal) {
    const detection = await this.detect(cwd, { refresh: true, signal });

    if (params.action === "status") {
      return this.statusText(detection);
    }

    if (params.action === "hydrate") {
      if (detection.hits.length === 0 && !params.force) {
        return `${await this.statusText(detection)}\n\nSkipped hydrate because no Effect dependency was found. Pass force=true if this repo is weird.`;
      }

      await this.hydrate(detection, signal);
      return `${await this.statusText(detection)}\n\nHydrated Effect source mirror.`;
    }

    if (params.action === "search") {
      const query = params.query?.trim();
      if (!query) throw new Error("effect_source search requires query.");
      if (detection.hits.length === 0 && !params.force) {
        return `${await this.statusText(detection)}\n\nSkipped search because no Effect dependency was found. Pass force=true if this repo is weird.`;
      }

      return this.search(detection, query, signal);
    }

    throw new Error(`Unknown effect_source action: ${params.action satisfies never}`);
  }

  sourceRule() {
    return `

# Effect source rule (pi-effect)

This repo uses Effect. Before writing, reviewing, or refactoring Effect code, run \`effect_source\` with action \`status\` and verify the official source mirror at \`${this.mirrorRelative}\` matches the project's Effect major. Canonical \`main\` is Effect v4; Effect v3 lives on the upstream \`v3\` branch. If the mirror is missing, use action \`hydrate\` first. Search source, tests, and examples before calling anything an Effect best practice. Do not rely on stale memory or blog snippets.
`;
  }

  private async createDetection(root: string, isGitRepo: boolean): Promise<Detection> {
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
            const versionSpec = String((deps as Record<string, unknown>)[dependency]);
            hits.push({
              packagePath: relative(root, packageFile),
              dependency,
              field,
              versionSpec,
              major: effectMajorFromVersionSpec(versionSpec),
            });
          }
        }
      }
    }

    return { root, isGitRepo, hits };
  }

  private async hydrateRoot(detection: Detection, signal?: AbortSignal) {
    await this.ensureExcluded(detection.root, detection.isGitRepo, signal);

    const mirror = await this.mirrorStatus(detection.root);
    if (mirror.ready) return;
    if (mirror.exists && !mirror.ready) {
      throw new Error(`${this.mirrorRelative} exists but does not look like the Effect repo.`);
    }

    await mkdir(join(detection.root, dirname(this.mirrorRelative)), { recursive: true });
    const branch = sourceBranchFor(detection);
    if (!branch) {
      throw new Error(
        "Cannot resolve the Effect source branch from floating or aliased dependency specs. Pin Effect exactly before hydrating source.",
      );
    }

    await this.processAdapter.cloneShallow({
      cwd: detection.root,
      repoUrl: this.effectRepoUrl,
      target: this.mirrorRelative,
      branch,
      signal,
    });
  }

  private async ensureExcluded(root: string, isGitRepo: boolean, signal?: AbortSignal) {
    if (!isGitRepo) return undefined;

    const excludePath = await this.processAdapter.getGitExcludePath(root, signal);
    await mkdir(resolve(excludePath, ".."), { recursive: true });

    const current = (await readFile(excludePath, "utf8").catch(() => ""))
      .split(/\r?\n/)
      .map((line) => line.trim());

    if (!current.includes(this.excludeEntry)) {
      await appendFile(excludePath, `${current.length > 0 ? "\n" : ""}${this.excludeEntry}\n`, "utf8");
    }

    return excludePath;
  }
}

export function createEffectSourceWorkspace(options?: WorkspaceOptions) {
  return new EffectSourceWorkspace(options);
}

function formatDependencyHits(hits: DependencyHit[]) {
  if (hits.length === 0) return "No Effect dependencies found.";
  return hits
    .map((hit) => `- ${hit.packagePath}: ${hit.dependency} (${hit.field}): ${hit.versionSpec}`)
    .join("\n");
}

function effectMajorFromVersionSpec(versionSpec: string): EffectMajor | undefined {
  if (versionSpec === "beta" || /(?:^|[^0-9])4\./.test(versionSpec)) return 4;
  if (/(?:^|[^0-9])3\./.test(versionSpec)) return 3;
  return undefined;
}

function detectedMajors(detection: Detection) {
  return new Set(detection.hits.flatMap((hit) => (hit.major ? [hit.major] : [])));
}

function sourceBranchFor(detection: Detection): "main" | "v3" | undefined {
  const majors = detectedMajors(detection);
  if (majors.size === 0 && detection.hits.length > 0) return undefined;
  return majors.size === 1 && majors.has(3) ? "v3" : "main";
}

function sourceVersionWarning(detection: Detection, mirror: MirrorStatus) {
  const majors = detectedMajors(detection);
  if (detection.hits.some((hit) => hit.major === undefined)) {
    return "Cannot resolve the Effect source branch from floating or aliased dependency specs. Pin Effect exactly before hydrating or searching source.";
  }
  if (majors.size > 1) {
    return `Mixed Effect majors detected. The shared mirror is Effect ${mirror.effectVersion ?? "unknown"}; inspect each package's exact installed source before copying APIs.`;
  }
  if (majors.size === 1 && mirror.major && !majors.has(mirror.major)) {
    const projectMajor = [...majors][0];
    return `Effect source major mismatch: project dependencies require v${projectMajor}, but the mirror contains ${mirror.effectVersion ?? `v${mirror.major}`}. Recreate the mirror from the ${projectMajor === 3 ? "v3" : "main"} branch before searching.`;
  }

  const exactCoreVersions = new Set(
    detection.hits
      .filter((hit) => hit.dependency === "effect" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(hit.versionSpec))
      .map((hit) => hit.versionSpec),
  );
  if (exactCoreVersions.size === 1 && mirror.effectVersion && !exactCoreVersions.has(mirror.effectVersion)) {
    const projectVersion = [...exactCoreVersions][0];
    return `Effect source version mismatch: project dependencies pin ${projectVersion}, but the mirror contains ${mirror.effectVersion}. Refresh or recreate the mirror at the project's exact source version before searching.`;
  }
  return undefined;
}

async function readPackageVersion(packagePath: string) {
  try {
    const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
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
