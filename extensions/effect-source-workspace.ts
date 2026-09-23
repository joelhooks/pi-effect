import { constants } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";
import { createNodeProcessAdapter, type SourceProcessAdapter } from "./process-adapter.ts";

export const EFFECT_REPO_URL = "https://github.com/Effect-TS/effect.git";
export const EFFECT_MIRROR_RELATIVE = ".agent_sources/github.com/Effect-TS/effect";
export const LEGACY_EFFECT_MIRROR_RELATIVE = ".agent-sources/effect";
export const EFFECT_EXCLUDE_ENTRIES = [".agent_sources/", ".agent-sources/", ".agent-source/"] as const;

const EFFECT_OWNER = "Effect-TS";
const EFFECT_REPO = "effect";
const EFFECT_METADATA_FILE = ".agent-source.json";
const packageDependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const skippedDirectories = new Set([
  ".agent-source",
  ".agent-sources",
  ".agent_sources",
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
export type EffectMajor = 3 | 4;
type MirrorLayout = "rat-stack" | "legacy" | "missing";
type MetadataState = "valid" | "missing" | "invalid";

export interface EffectSourceParams {
  action: EffectAction;
  query?: string;
  force?: boolean;
}

export interface DependencyHit {
  packagePath: string;
  dependency: string;
  field: string;
  versionSpec: string;
  resolvedVersionSpec: string;
  major: EffectMajor | undefined;
}

export interface Detection {
  root: string;
  isGitRepo: boolean;
  hits: DependencyHit[];
}

export interface MirrorStatus {
  path: string;
  layout: MirrorLayout;
  exists: boolean;
  ready: boolean;
  effectVersion: string | undefined;
  major: EffectMajor | undefined;
  sourceRef: string | undefined;
  metadataState: MetadataState;
}

interface DetectOptions {
  refresh?: boolean;
  signal?: AbortSignal;
}

interface WorkspaceOptions {
  processAdapter?: SourceProcessAdapter;
  effectRepoUrl?: string;
  mirrorRelative?: string;
  legacyMirrorRelative?: string;
}

interface SourceRefResolution {
  ref: string | undefined;
  major: EffectMajor | undefined;
  exactVersion: string | undefined;
  warning: string | undefined;
}

interface SourceWarning {
  message: string;
  blocksSearch: boolean;
}

interface WorkspaceManifest {
  packagePatterns: string[];
  defaultCatalog: Record<string, string>;
  namedCatalogs: Record<string, Record<string, string>>;
}

interface AgentSourceMetadata {
  type: "github-repo-source";
  owner: string;
  repo: string;
  remote: string;
  ref: string;
  commit: string;
}

export class EffectSourceWorkspace {
  private readonly processAdapter: SourceProcessAdapter;
  private readonly effectRepoUrl: string;
  private readonly mirrorRelative: string;
  private readonly legacyMirrorRelative: string;
  private readonly detectionCache = new Map<string, Promise<Detection>>();
  private readonly hydrationByRoot = new Map<string, Promise<void>>();

  constructor(options: WorkspaceOptions = {}) {
    this.processAdapter = options.processAdapter ?? createNodeProcessAdapter();
    this.effectRepoUrl = options.effectRepoUrl ?? EFFECT_REPO_URL;
    this.mirrorRelative = options.mirrorRelative ?? EFFECT_MIRROR_RELATIVE;
    this.legacyMirrorRelative = options.legacyMirrorRelative ?? LEGACY_EFFECT_MIRROR_RELATIVE;
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
    const currentPath = join(root, this.mirrorRelative);
    const legacyPath = join(root, this.legacyMirrorRelative);
    const currentExists = await directoryExists(currentPath);
    const legacyExists = !currentExists && (await directoryExists(legacyPath));
    const mirrorPath = currentExists ? currentPath : legacyExists ? legacyPath : currentPath;
    const layout: MirrorLayout = currentExists ? "rat-stack" : legacyExists ? "legacy" : "missing";
    const exists = currentExists || legacyExists;
    const ready = exists && (await directoryExists(join(mirrorPath, "packages/effect/src")));
    const effectVersion = ready
      ? await readPackageVersion(join(mirrorPath, "packages/effect/package.json"))
      : undefined;
    const metadata = exists ? await readAgentSourceMetadata(join(mirrorPath, EFFECT_METADATA_FILE)) : undefined;

    return {
      path: mirrorPath,
      layout,
      exists,
      ready,
      effectVersion,
      major: effectVersion ? effectMajorFromVersionSpec(effectVersion) : undefined,
      sourceRef: metadata?.ref,
      metadataState: !exists || layout === "legacy" ? "missing" : metadata ? "valid" : "invalid",
    };
  }

  async hydrate(detection: Detection, signal?: AbortSignal, force = false) {
    const inFlight = this.hydrationByRoot.get(detection.root);
    if (inFlight) return inFlight;

    const hydrate = this.hydrateRoot(detection, signal, force).finally(() => {
      this.hydrationByRoot.delete(detection.root);
    });

    this.hydrationByRoot.set(detection.root, hydrate);
    return hydrate;
  }

  async statusText(detection: Detection, force = false) {
    const mirror = await this.mirrorStatus(detection.root);
    const resolution = sourceRefFor(detection, force);
    const warnings = sourceWarnings(detection, mirror, force);
    const expectedRef = resolution.ref
      ? `${resolution.ref} (${resolution.exactVersion ? "exact pin" : "major-branch fallback"})`
      : "unknown";

    return [
      `Repo root: ${detection.root}`,
      `Uses Effect: ${detection.hits.length > 0 ? "yes" : "no"}`,
      `Expected source ref: ${expectedRef}`,
      "",
      formatDependencyHits(detection.hits),
      "",
      `Mirror: ${relative(detection.root, mirror.path)}`,
      `Mirror layout: ${mirror.layout}`,
      `Mirror exists: ${mirror.exists ? "yes" : "no"}`,
      `Mirror ready: ${mirror.ready ? "yes" : "no"}`,
      `Mirror source ref: ${mirror.sourceRef ?? "not recorded"}`,
      `Mirror Effect version: ${mirror.effectVersion ?? "unknown"}`,
      ...(warnings.length > 0 ? ["", ...warnings.map((warning) => `Warning: ${warning.message}`)] : []),
    ].join("\n");
  }

  async search(detection: Detection, query: string, signal?: AbortSignal, force = false) {
    let mirror = await this.mirrorStatus(detection.root);
    const currentWarnings = sourceWarnings(detection, mirror, force);
    if (!mirror.ready || (mirror.layout === "legacy" && currentWarnings.some((warning) => warning.blocksSearch))) {
      await this.hydrate(detection, signal, force);
      mirror = await this.mirrorStatus(detection.root);
    }

    const blockingWarning = sourceWarnings(detection, mirror, force).find((warning) => warning.blocksSearch);
    if (blockingWarning) throw new Error(blockingWarning.message);

    const mirrorRelative = relative(detection.root, mirror.path);
    const result = await this.processAdapter.search({
      cwd: detection.root,
      query,
      paths: [join(mirrorRelative, "packages/effect/src"), join(mirrorRelative, "packages")],
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
      return this.statusText(detection, params.force);
    }

    if (params.action === "hydrate") {
      if (detection.hits.length === 0 && !params.force) {
        return `${await this.statusText(detection)}\n\nSkipped hydrate because no Effect dependency was found. Pass force=true if this repo is weird.`;
      }

      await this.hydrate(detection, signal, params.force);
      return `${await this.statusText(detection, params.force)}\n\nEffect source mirror is ready.`;
    }

    if (params.action === "search") {
      const query = params.query?.trim();
      if (!query) throw new Error("effect_source search requires query.");
      if (detection.hits.length === 0 && !params.force) {
        return `${await this.statusText(detection)}\n\nSkipped search because no Effect dependency was found. Pass force=true if this repo is weird.`;
      }

      return this.search(detection, query, signal, params.force);
    }

    throw new Error(`Unknown effect_source action: ${params.action satisfies never}`);
  }

  sourceRule() {
    return `

# Effect source rule (pi-effect)

This repo uses Effect. Before writing, reviewing, or refactoring Effect code, run \`effect_source\` with action \`status\` and verify the source ref and mirror version match the project's Effect pin. The canonical mirror is \`${this.mirrorRelative}\`; existing projects may still use \`${this.legacyMirrorRelative}\`. Exact pins resolve to their matching \`effect@<version>\` tag. A \`main\` or \`v3\` ref is a major-branch fallback, not an exact version match. If the mirror is missing, use action \`hydrate\` first. Search source, tests, and examples before calling anything an Effect best practice.
`;
  }

  private async createDetection(root: string, isGitRepo: boolean): Promise<Detection> {
    const workspace = await readWorkspaceManifest(root);
    const packageFiles = await findPackageJsonFiles(root, workspace.packagePatterns);
    const hits: DependencyHit[] = [];

    for (const packageFile of packageFiles) {
      const packageJson = await readJsonRecord(packageFile);
      if (!packageJson) continue;

      for (const field of packageDependencyFields) {
        const deps = asRecord(packageJson[field]);
        if (!deps) continue;

        for (const dependency of Object.keys(deps)) {
          if (dependency !== "effect" && !dependency.startsWith("@effect/")) continue;

          const versionSpec = String(deps[dependency]);
          const resolvedVersionSpec = resolveCatalogSpec(
            versionSpec,
            dependency,
            workspace.defaultCatalog,
            workspace.namedCatalogs,
          );
          hits.push({
            packagePath: relative(root, packageFile),
            dependency,
            field,
            versionSpec,
            resolvedVersionSpec,
            major: effectMajorFromVersionSpec(resolvedVersionSpec),
          });
        }
      }
    }

    return { root, isGitRepo, hits };
  }

  private async hydrateRoot(detection: Detection, signal?: AbortSignal, force = false) {
    await this.ensureExcluded(detection.root, detection.isGitRepo, signal);

    const resolution = sourceRefFor(detection, force);
    if (!resolution.ref) {
      throw new Error(resolution.warning ?? "Cannot resolve an Effect source ref.");
    }

    const mirror = await this.mirrorStatus(detection.root);
    if (mirror.ready) {
      const blockingWarning = sourceWarnings(detection, mirror, force).find((warning) => warning.blocksSearch);
      if (!blockingWarning) return;
      if (mirror.layout !== "legacy") {
        throw new Error(`${blockingWarning.message} Existing mirrors are left untouched; inspect or replace the mirror explicitly.`);
      }
    }
    if (mirror.exists && mirror.layout !== "legacy") {
      throw new Error(`${relative(detection.root, mirror.path)} exists but does not look like the Effect repo.`);
    }

    await mkdir(join(detection.root, dirname(this.mirrorRelative)), { recursive: true });
    const result = await this.processAdapter.cloneShallow({
      cwd: detection.root,
      repoUrl: this.effectRepoUrl,
      target: this.mirrorRelative,
      ref: resolution.ref,
      signal,
    });

    const metadata: AgentSourceMetadata & { addedAt: string; note: string } = {
      type: "github-repo-source",
      owner: EFFECT_OWNER,
      repo: EFFECT_REPO,
      remote: this.effectRepoUrl,
      ref: resolution.ref,
      commit: result.commit,
      addedAt: new Date().toISOString(),
      note: "Pi Effect source mirror. Refresh from the project's Effect pin.",
    };
    await writeFile(join(detection.root, this.mirrorRelative, EFFECT_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    const hydrated = await this.mirrorStatus(detection.root);
    const blockingWarning = sourceWarnings(detection, hydrated, force).find((warning) => warning.blocksSearch);
    if (blockingWarning) throw new Error(blockingWarning.message);
  }

  private async ensureExcluded(root: string, isGitRepo: boolean, signal?: AbortSignal) {
    if (!isGitRepo) return undefined;

    const excludePath = await this.processAdapter.getGitExcludePath(root, signal);
    await mkdir(resolve(excludePath, ".."), { recursive: true });

    const current = (await readFile(excludePath, "utf8").catch(() => ""))
      .split(/\r?\n/)
      .map((line) => line.trim());

    const missingEntries = EFFECT_EXCLUDE_ENTRIES.filter((entry) => !current.includes(entry));
    if (missingEntries.length > 0) {
      await appendFile(excludePath, `${current.some(Boolean) ? "\n" : ""}${missingEntries.join("\n")}\n`, "utf8");
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
    .map((hit) => {
      const spec = hit.versionSpec === hit.resolvedVersionSpec
        ? hit.versionSpec
        : `${hit.versionSpec} -> ${hit.resolvedVersionSpec}`;
      return `- ${hit.packagePath}: ${hit.dependency} (${hit.field}): ${spec}`;
    })
    .join("\n");
}

function sourceRefFor(detection: Detection, force = false): SourceRefResolution {
  const detectedMajors = new Set(detection.hits.flatMap((hit) => (hit.major ? [hit.major] : [])));
  if (detectedMajors.size > 1) {
    return {
      ref: undefined,
      major: undefined,
      exactVersion: undefined,
      warning: `Mixed Effect majors detected (${[...detectedMajors].map((major) => `v${major}`).join(", ")}); one source mirror cannot represent both.`,
    };
  }

  const coreExactVersions = new Set(
    detection.hits
      .filter((hit) => hit.dependency === "effect" && isExactVersion(hit.resolvedVersionSpec))
      .map((hit) => hit.resolvedVersionSpec),
  );
  if (coreExactVersions.size === 1) {
    const exactVersion = [...coreExactVersions][0];
    return { ref: `effect@${exactVersion}`, major: effectMajorFromVersionSpec(exactVersion), exactVersion, warning: undefined };
  }
  if (coreExactVersions.size > 1) {
    return {
      ref: undefined,
      major: undefined,
      exactVersion: undefined,
      warning: `Multiple exact effect versions are used (${[...coreExactVersions].join(", ")}); one source mirror cannot represent both.`,
    };
  }

  const exactVersions = new Set(
    detection.hits
      .filter((hit) => hit.major !== undefined && isExactVersion(hit.resolvedVersionSpec))
      .map((hit) => hit.resolvedVersionSpec),
  );
  if (exactVersions.size === 1) {
    const exactVersion = [...exactVersions][0];
    return { ref: `effect@${exactVersion}`, major: effectMajorFromVersionSpec(exactVersion), exactVersion, warning: undefined };
  }
  if (exactVersions.size > 1) {
    return {
      ref: undefined,
      major: undefined,
      exactVersion: undefined,
      warning: `Multiple exact Effect package versions are used (${[...exactVersions].join(", ")}); one source mirror cannot represent both.`,
    };
  }

  const majors = detectedMajors;
  const unresolved = detection.hits.filter((hit) => hit.major === undefined);
  if (majors.size === 1 && unresolved.length === 0) {
    const major = [...majors][0];
    const ref = major === 3 ? "v3" : "main";
    return {
      ref,
      major,
      exactVersion: undefined,
      warning: `No exact Effect version pin was found; using ${ref} as a v${major} branch fallback.`,
    };
  }
  if (detection.hits.length === 0) {
    return force
      ? {
          ref: "main",
          major: 4,
          exactVersion: undefined,
          warning: "No Effect dependency was detected; using main only because force=true.",
        }
      : { ref: undefined, major: undefined, exactVersion: undefined, warning: undefined };
  }

  return {
    ref: undefined,
    major: undefined,
    exactVersion: undefined,
    warning: `Cannot resolve an Effect source ref from ${unresolved.map((hit) => `${hit.dependency}=${hit.versionSpec}`).join(", ") || "the detected dependency specs"}. Resolve catalog entries or pin Effect exactly before hydrating or searching source.`,
  };
}

function sourceWarnings(detection: Detection, mirror: MirrorStatus, force = false): SourceWarning[] {
  const resolution = sourceRefFor(detection, force);
  const warnings: SourceWarning[] = [];
  if (resolution.warning) {
    warnings.push({
      message: resolution.warning,
      blocksSearch: !resolution.ref,
    });
  }
  if (!mirror.ready) return warnings;

  if (resolution.exactVersion && mirror.effectVersion !== resolution.exactVersion) {
    warnings.push({
      message: `Effect source version mismatch: project pins ${resolution.exactVersion}, but the mirror contains ${mirror.effectVersion ?? "an unknown version"}.`,
      blocksSearch: true,
    });
  }
  if (resolution.exactVersion && mirror.sourceRef && mirror.sourceRef !== resolution.ref) {
    warnings.push({
      message: `Effect source ref mismatch: project expects ${resolution.ref}, but mirror metadata records ${mirror.sourceRef}.`,
      blocksSearch: true,
    });
  }
  if (resolution.major && mirror.major && resolution.major !== mirror.major) {
    warnings.push({
      message: `Effect source major mismatch: project dependencies require v${resolution.major}, but the mirror contains ${mirror.effectVersion ?? `v${mirror.major}`}.`,
      blocksSearch: true,
    });
  }
  if (mirror.metadataState !== "valid") {
    const reason = mirror.metadataState === "missing" ? "has no .agent-source.json ref metadata" : "has invalid .agent-source.json metadata";
    warnings.push({
      message: `Effect mirror ${reason}; its source ref cannot be verified.`,
      blocksSearch: false,
    });
  }
  if (mirror.layout === "legacy") {
    warnings.push({
      message: `Using legacy mirror path ${LEGACY_EFFECT_MIRROR_RELATIVE}; new mirrors use ${EFFECT_MIRROR_RELATIVE}.`,
      blocksSearch: false,
    });
  }
  return warnings;
}

function effectMajorFromVersionSpec(versionSpec: string): EffectMajor | undefined {
  const match = /^(?:[~^<>=]|\s)*(?:v)?([34])(?:\.|$)/.exec(versionSpec.trim());
  if (match?.[1] === "3") return 3;
  if (match?.[1] === "4") return 4;
  return undefined;
}

function isExactVersion(versionSpec: string) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(versionSpec);
}

function resolveCatalogSpec(
  versionSpec: string,
  dependency: string,
  defaultCatalog: Record<string, string>,
  namedCatalogs: Record<string, Record<string, string>>,
) {
  if (!versionSpec.startsWith("catalog:")) return versionSpec;
  const catalogName = versionSpec.slice("catalog:".length).trim();
  const catalog = catalogName ? namedCatalogs[catalogName] : defaultCatalog;
  return catalog?.[dependency] ?? versionSpec;
}

async function readWorkspaceManifest(root: string): Promise<WorkspaceManifest> {
  const rootPackage = await readJsonRecord(join(root, "package.json"));
  const workspaces = rootPackage?.workspaces;
  const npmPatterns = Array.isArray(workspaces)
    ? workspaces.filter((pattern): pattern is string => typeof pattern === "string")
    : asRecord(workspaces)?.packages;
  const packagePatterns = Array.isArray(npmPatterns)
    ? npmPatterns.filter((pattern): pattern is string => typeof pattern === "string")
    : [];

  let defaultCatalog: Record<string, string> = {};
  let namedCatalogs: Record<string, Record<string, string>> = {};
  try {
    const pnpmWorkspace = asRecord(parseYaml(await readFile(join(root, "pnpm-workspace.yaml"), "utf8")));
    const pnpmPatterns = Array.isArray(pnpmWorkspace?.packages)
      ? pnpmWorkspace.packages.filter((pattern): pattern is string => typeof pattern === "string")
      : [];
    packagePatterns.push(...pnpmPatterns);
    defaultCatalog = stringRecord(pnpmWorkspace?.catalog);
    const catalogs = asRecord(pnpmWorkspace?.catalogs);
    if (catalogs) {
      namedCatalogs = Object.fromEntries(
        Object.entries(catalogs).map(([name, catalog]) => [name, stringRecord(catalog)]),
      );
    }
  } catch {
    // A broken workspace file leaves catalog: specs unresolved and visible in status.
  }

  return { packagePatterns: normalizePatterns(packagePatterns), defaultCatalog, namedCatalogs };
}

function normalizePatterns(patterns: string[]) {
  return [...new Set(patterns.map((pattern) => pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")))];
}

async function findPackageJsonFiles(root: string, workspacePatterns: string[]) {
  const direct = join(root, "package.json");
  const files = (await pathExists(direct)) ? [direct] : [];
  if (workspacePatterns.length === 0) return files;

  const includes = workspacePatterns.filter((pattern) => !pattern.startsWith("!"));
  const excludes = workspacePatterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  if (includes.length === 0) return files;

  const found: string[] = [];
  const maxDepth = 12;
  const maxFiles = 1_000;

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
        const packageDirectory = relative(root, dirname(join(dir, entry.name))).split(sep).join("/");
        const included = includes.some((pattern) => minimatch(packageDirectory, pattern, { dot: true }));
        const excluded = excludes.some((pattern) => minimatch(packageDirectory, pattern, { dot: true }));
        if (included && !excluded) found.push(join(dir, entry.name));
      }
    }
  }

  await walk(root, 0);
  return [...new Set([...files, ...found])];
}

async function readAgentSourceMetadata(path: string): Promise<AgentSourceMetadata | undefined> {
  const parsed = await readJsonRecord(path);
  if (
    parsed?.type !== "github-repo-source" ||
    parsed.owner !== EFFECT_OWNER ||
    parsed.repo !== EFFECT_REPO ||
    parsed.remote !== EFFECT_REPO_URL ||
    typeof parsed.ref !== "string" ||
    typeof parsed.commit !== "string"
  ) {
    return undefined;
  }
  return parsed as unknown as AgentSourceMetadata;
}

async function readJsonRecord(path: string) {
  try {
    return asRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function readPackageVersion(packagePath: string) {
  const parsed = await readJsonRecord(packagePath);
  return typeof parsed?.version === "string" ? parsed.version : undefined;
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
