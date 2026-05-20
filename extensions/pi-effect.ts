import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  createEffectSourceWorkspace,
  type EffectSourceParams,
} from "./effect-source-workspace.ts";

function parseCommandArgs(args: string): EffectSourceParams {
  const trimmed = args.trim();
  if (!trimmed) return { action: "status" };

  const [action, ...rest] = trimmed.split(/\s+/);
  if (action === "status" || action === "hydrate") return { action };
  if (action === "search") return { action, query: rest.join(" ") };

  return { action: "search", query: trimmed };
}

export default function piEffectExtension(pi: ExtensionAPI) {
  const workspace = createEffectSourceWorkspace();

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
      const text = await workspace.runAction(params as EffectSourceParams, ctx.cwd, signal);
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
      const text = await workspace.runAction(params, ctx.cwd, ctx.signal);
      pi.sendMessage({
        customType: "pi-effect",
        content: text,
        display: true,
        details: { action: params.action },
      });
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const detection = await workspace.detect(ctx.cwd, { signal: ctx.signal });
    if (detection.hits.length === 0) return;

    let hydrationNote = "";
    const mirror = await workspace.mirrorStatus(detection.root);
    if (!mirror.ready) {
      try {
        await workspace.hydrate(detection, ctx.signal);
        hydrationNote = "\n\npi-effect already hydrated `.agent-sources/effect/` for this repo.";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        hydrationNote = `\n\npi-effect tried to hydrate \`.agent-sources/effect/\` but failed: ${message}`;
      }
    }

    return {
      systemPrompt: `${event.systemPrompt}${workspace.sourceRule()}${hydrationNote}`,
    };
  });
}
