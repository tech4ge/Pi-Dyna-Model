/**
 * Pi-Dyna-Model — a virtual model that plans on a strong model and implements on a cheap one.
 *
 * Registers `dyna/auto`. A session starts on the planning model. The phase is a fold over the
 * transcript, in order:
 *
 * - a successful source-file edit (test authoring excluded) or a test-suite command switches to
 *   the implementation model;
 * - a git return to a trunk branch or a new branch (`git checkout main`, `git switch main`,
 *   `git checkout -b …`, `git switch -c …`) resets to the planning model — the DONE transition —
 *   so a new issue in the same session plans on the strong model again. The trunk branches are
 *   configurable via `resetBranches` (default `main` and `master`) so repos that branch off
 *   `develop` or another parent branch reset at their own merge gate.
 *
 * The latest signal wins; one switch per unit of work means one prompt-cache miss. The transcript
 * is authoritative while it carries signals; stored router state covers transcripts compacted
 * before their signals. State survives forks and `/tree` navigation.
 *
 * Requests outside the agent loop (compaction summaries, extension calls) go to the implementation
 * model. Retries are sticky by construction. Manual override at any time with `/model <physical>`.
 *
 * Effort follows the phase: planning dispatches at the selected thinking level (or `planThinking`
 * if configured), while the implementation phase and direct requests dispatch at
 * `implementThinking` — "high" by default, so the implementation model still self-checks its
 * edits; the flash tier is where careless-generation slips (unbalanced syntax, broken imports)
 * actually cost time.
 *
 * Configure via a `dynaModel` key in settings.json (project `.pi/settings.json` overrides the
 * global one; read per request, no `/reload` needed):
 *
 *   {
 *     "dynaModel": {
 *       "plan": "neural-watt/glm-5.3",
 *       "implement": "neural-watt/glm-5.3-flash",
 *       "testCommand": "vitest|npm (run )?test|supabase db test|check:emit-loss",
 *       "resetBranches": ["main", "develop"],
 *       "implementThinking": "high"
 *     }
 *   }
 *
 * Usage: `/model dyna/auto`
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

/** Mirrors pi's VIRTUAL_MODEL_STATE_ENTRY — a value import from the pi package is not bound by
 * the extension loader, so the literal is used instead. */
const VIRTUAL_MODEL_STATE_ENTRY = "pi.virtual-model-state";

const DEFAULT_PLAN = "neural-watt/glm-5.3";
const DEFAULT_IMPLEMENT = "neural-watt/glm-5.3-flash";
/** Thinking level dispatched for the implementation phase and direct requests.
 * GLM-5.3's real ladder is low/high/max — reasoning is always on and cannot be disabled.
 * "high": the implementation model is a flagship tier, and low effort showed shallow
 * execution slips (unbalanced syntax, oscillating fix/refail loops) in practice. */
const DEFAULT_IMPLEMENT_THINKING: ModelThinkingLevel = "high";
/** Bash commands whose run means the mechanical phase has begun. Anchored to command starts
 * (or after && ; |) so probes like `ls vitest.config.*` and prose mentioning a suite don't match. */
const DEFAULT_TEST_COMMAND =
	"(^|[;&|(]\\s*)((npx\\s+)?vitest|npm\\s+(run\\s+)?test|supabase\\s+db\\s+test|npm\\s+run\\s+check:emit-loss)\\b";
/** Paths whose writes are test authoring, not implementation. */
const TEST_PATH = /\.spec\.[cm]?[jt]sx?$|\.test\.[cm]?[jt]sx?$|(^|[\\/])supabase[\\/]tests[\\/]|[\\/]__tests__[\\/]/;
/** Paths whose writes are notes, plans, or process bookkeeping — not implementation.
 * Plan documents (.scratch), the kanban board, and docs stay on the planning model. */
const NON_CODE_PATH = /(^|[\\/])(\.scratch|kanban|docs)[\\/]|\.md$/;
/** Bash commands that end a unit of work: returning to a trunk branch, or starting a new one. */
const NEW_BRANCH_COMMAND = /git (?:checkout|switch) (?:-b\s|-B\s)|git switch -c\s/;
/** Trunk branches whose checkout ends a unit of work. */
const DEFAULT_RESET_BRANCHES = ["main", "master"];

/** Escapes a literal branch name for embedding in a regex. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds the reset matcher for the configured trunk branches, e.g. `main` and `develop`. */
function buildResetCommand(branches: readonly string[]): RegExp {
	return new RegExp(`git (?:checkout|switch) (?:${branches.map(escapeRegExp).join("|")})(?![\\w.-])`);
}

/** Tools that modify files. */
const EDIT_TOOLS = new Set(["edit", "write"]);

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

interface DynaState {
	phase: "plan" | "implement";
}

type DynaRequest = ModelRouteRequest<DynaState>;

interface DynaConfig {
	/** Planning model, as "provider/model-id". */
	plan: string;
	/** Implementation model, as "provider/model-id". */
	implement: string;
	/** Bash commands matching this pattern trigger the switch to implementation. */
	testCommand: RegExp;
	/** Trunk branches whose successful checkout resets to the planning phase. */
	resetCommand: RegExp;
	/** Thinking level for the planning phase. Undefined passes the selected level through. */
	planThinking?: ModelThinkingLevel;
	/** Thinking level for the implementation phase. */
	implementThinking: ModelThinkingLevel;
}

/** Reads and merges pi's settings files — project overrides global, as pi does. */
function readSettings(cwd: string): Record<string, unknown> | undefined {
	const files = [
		join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json"),
		join(cwd, ".pi", "settings.json"),
	];
	let merged: Record<string, unknown> | undefined;
	for (const file of files) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (parsed && typeof parsed === "object") merged = { ...(merged ?? {}), ...(parsed as Record<string, unknown>) };
		} catch {
			// Missing or invalid file: skip it.
		}
	}
	return merged;
}

export function readConfig(cwd: string): DynaConfig {
	const raw = readSettings(cwd)?.dynaModel;
	const plan = typeof raw?.plan === "string" && raw.plan.includes("/") ? raw.plan : DEFAULT_PLAN;
	const implement = typeof raw?.implement === "string" && raw.implement.includes("/") ? raw.implement : DEFAULT_IMPLEMENT;
	const pattern = typeof raw?.testCommand === "string" && raw.testCommand.length > 0 ? raw.testCommand : DEFAULT_TEST_COMMAND;
	const planThinking = typeof raw?.planThinking === "string" && THINKING_LEVELS.has(raw.planThinking) ? (raw.planThinking as ModelThinkingLevel) : undefined;
	const resetBranches =
		Array.isArray(raw?.resetBranches) && raw.resetBranches.length > 0 && raw.resetBranches.every((b: unknown) => typeof b === "string" && b.length > 0)
			? (raw.resetBranches as string[])
			: DEFAULT_RESET_BRANCHES;
	const implementThinking =
		typeof raw?.implementThinking === "string" && THINKING_LEVELS.has(raw.implementThinking)
			? (raw.implementThinking as ModelThinkingLevel)
			: DEFAULT_IMPLEMENT_THINKING;
	return { plan, implement, testCommand: new RegExp(pattern), resetCommand: buildResetCommand(resetBranches), planThinking, implementThinking };
}

function findModel(ctx: ExtensionContext, spec: string) {
	const slash = spec.indexOf("/");
	const model = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
	if (!model) throw new Error(`dyna/auto: ${spec} is not in the model catalog (check the provider's credentials)`);
	return model;
}

function routeTo(
	request: DynaRequest,
	ctx: ExtensionContext,
	spec: string,
	opts: { state?: DynaState; thinking?: ModelThinkingLevel } = {},
): ModelRoute<DynaState> {
	const model = findModel(ctx, spec);
	const route: ModelRoute<DynaState> = { model, thinkingLevel: opts.thinking ?? request.thinkingLevel };
	if (opts.state) route.state = opts.state;
	return route;
}

/**
 * Phase fold over the transcript, in message order. A successful source-file edit or a
 * test-suite command sets "implement"; a successful git return to main or new branch resets
 * "plan". The latest signal wins. Undefined when the transcript carries no signal.
 */
/** A phase signal from the transcript: the phase it sets, and the tool call that produced it. */
export interface PhaseSignal {
	phase: "plan" | "implement";
	signalId: string;
}

export function foldPhase(messages: readonly Message[], testCommand: RegExp, resetCommand: RegExp, newBranchCommand = NEW_BRANCH_COMMAND): PhaseSignal | undefined {
	let signal: PhaseSignal | undefined;
	const pending = new Map<string, { kind: "bash"; command: string } | { kind: "edit"; path: string }>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (block.name === "bash") {
					const command = typeof block.arguments.command === "string" ? block.arguments.command : "";
					// A test-suite command counts the moment it is made: a red run still
					// means implementation has begun.
					if (testCommand.test(command)) signal = { phase: "implement", signalId: block.id };
					pending.set(block.id, { kind: "bash", command });
				} else if (EDIT_TOOLS.has(block.name)) {
					pending.set(block.id, { kind: "edit", path: typeof block.arguments.path === "string" ? block.arguments.path : "" });
				}
			}
		} else if (message.role === "toolResult" && !message.isError) {
			const call = pending.get(message.toolCallId);
			if (!call) continue;
			if (call.kind === "bash") {
				// Only a successful checkout proves the return to a trunk branch happened.
				if (resetCommand.test(call.command) || newBranchCommand.test(call.command)) signal = { phase: "plan", signalId: message.toolCallId };
			} else if (!TEST_PATH.test(call.path) && !NON_CODE_PATH.test(call.path)) {
				signal = { phase: "implement", signalId: message.toolCallId };
			}
		}
	}
	return signal;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("dyna", {
		description: "Dyna Auto: force the routing phase — /dyna plan or /dyna implement. Holds until the next transcript signal (edit, test run, or git boundary).",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg !== "plan" && arg !== "implement") {
				ctx.ui.notify("Usage: /dyna plan | /dyna implement", "warning");
				return;
			}
			pi.appendEntry(VIRTUAL_MODEL_STATE_ENTRY, { provider: "dyna", modelId: "auto", state: { phase: arg, manual: true } });
			ctx.ui.notify(`Dyna: manual ${arg} phase — next request routes to the ${arg === "plan" ? "planning" : "implementation"} model`, "info");
		},
	});
	pi.registerVirtualModel<DynaState>({
		provider: "dyna",
		id: "auto",
		name: "Dyna Auto",
		thinkingLevels: ["low", "medium", "high", "xhigh"],
		contextWindow: 400_000,
		route(request, ctx) {
			const config = readConfig(ctx.cwd);
			// Requests outside the agent loop, such as compaction summaries, are mechanical.
			if (request.reason === "direct") return routeTo(request, ctx, config.implement, { thinking: config.implementThinking });
			const fold = foldPhase(request.messages, config.testCommand, config.resetCommand);
			// Manual override (/dyna plan|implement): holds until the transcript produces a
			// signal the override was not pinned against.
			if (request.state?.manual) {
				if (request.state.signalId === fold?.signalId) return manualRoute(request, ctx, config, request.state);
				if (request.state.signalId === undefined && fold) return manualRoute(request, ctx, config, { ...request.state, signalId: fold.signalId });
				// A new signal arrived since the override: it expires, the fold wins.
			}
			// The transcript is authoritative while it carries signals; stored state covers
			// transcripts compacted before their signals.
			const phase = fold?.phase ?? request.state?.phase ?? "plan";
			if (phase === "implement") {
				return routeTo(request, ctx, config.implement, { state: request.state ?? { phase: "implement" }, thinking: config.implementThinking });
			}
			// A reset back to plan is stored, so a later compacted transcript still routes correctly.
			const state = request.state?.phase === "implement" ? { phase: "plan" as const } : undefined;
			return routeTo(request, ctx, config.plan, { state, thinking: config.planThinking });
		},
	});
}

function manualRoute(request: DynaRequest, ctx: ExtensionContext, config: DynaConfig, state: DynaState): ModelRoute<DynaState> {
	if (state.phase === "implement") return routeTo(request, ctx, config.implement, { state, thinking: config.implementThinking });
	return routeTo(request, ctx, config.plan, { state, thinking: config.planThinking });
}
