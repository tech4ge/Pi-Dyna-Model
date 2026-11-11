import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { foldPhase, readConfig } from "../index.ts";

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): Message {
	return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } as unknown as Message;
}

function toolResult(toolName: string, toolCallId: string, isError = false): Message {
	return { role: "toolResult", toolName, toolCallId, content: [], isError } as unknown as Message;
}

const PATTERN = /(^|[;&|(]\s*)((npx\s+)?vitest|npm\s+(run\s+)?test|supabase\s+db\s+test|npm\s+run\s+check:emit-loss)\b/;
const RESET = /git (?:checkout|switch) (?:main|master)(?![\w.-])/;
const NEW_BRANCH = /git (?:checkout|switch) (?:-b\s|-B\s)|git switch -c\s/;

function fold(messages: Message[], resetCommand: RegExp = RESET) {
	return foldPhase(messages, PATTERN, resetCommand, NEW_BRANCH);
}

describe("foldPhase", () => {
	it("switches to implement on a successful source-file edit", () => {
		const messages = [assistantToolCall("1", "edit", { path: "src/lib/foo.ts", edits: [] }), toolResult("edit", "1")];
		expect(fold(messages)).toEqual({ phase: "implement", signalId: "1" });
	});

	it("ignores plan documents and kanban board files", () => {
		const messages = [
			assistantToolCall("1", "write", { path: ".scratch/feature/508-plan.md", content: "" }),
			toolResult("write", "1"),
			assistantToolCall("2", "write", { path: "kanban/board.md", content: "" }),
			toolResult("write", "2"),
			assistantToolCall("3", "write", { path: "docs/agents/spot-fix.md", content: "" }),
			toolResult("write", "3"),
		];
		expect(fold(messages)).toBeUndefined();
	});

	it("ignores test-file writes", () => {
		const messages = [
			assistantToolCall("1", "write", { path: "src/lib/foo.spec.ts", content: "" }),
			toolResult("write", "1"),
			assistantToolCall("2", "write", { path: "supabase/tests/x.sql", content: "" }),
			toolResult("write", "2"),
		];
		expect(fold(messages)).toBeUndefined();
	});

	it("ignores failed edits", () => {
		const messages = [assistantToolCall("1", "edit", { path: "src/lib/foo.ts", edits: [] }), toolResult("edit", "1", true)];
		expect(fold(messages)).toBeUndefined();
	});

	it("switches to implement on a test run, red included, but not on probe commands", () => {
		expect(fold([assistantToolCall("1", "bash", { command: "npx vitest run src/lib/foo.spec.ts" })])?.phase).toBe("implement");
		expect(fold([assistantToolCall("2", "bash", { command: "supabase db test --local 2>&1 | tail -8" })])?.phase).toBe("implement");
		expect(fold([assistantToolCall("3", "bash", { command: "cd sub && npm test" })])?.phase).toBe("implement");
		expect(fold([assistantToolCall("4", "bash", { command: "ls vitest.config.* 2>/dev/null; cat vitest.config.ts" })])).toBeUndefined();
		expect(fold([assistantToolCall("5", "bash", { command: "kanban-md edit 524 -a \"note about vitest suite\"" })])).toBeUndefined();
	});

	it("resets to plan on a successful return to main", () => {
		const messages = [
			assistantToolCall("1", "edit", { path: "src/lib/foo.ts", edits: [] }),
			toolResult("edit", "1"),
			assistantToolCall("2", "bash", { command: "git checkout main" }),
			toolResult("bash", "2"),
		];
		expect(fold(messages)).toEqual({ phase: "plan", signalId: "2" });
	});

	it("resets to plan on a successful checkout of a configured trunk branch", () => {
		const develop = /git (?:checkout|switch) (?:main|develop)(?![\w.-])/;
		const messages = [
			assistantToolCall("1", "edit", { path: "src/lib/foo.ts", edits: [] }),
			toolResult("edit", "1"),
			assistantToolCall("2", "bash", { command: "git checkout develop && git merge feature/508-x" }),
			toolResult("bash", "2"),
		];
		expect(fold(messages, develop)).toEqual({ phase: "plan", signalId: "2" });
	});

	it("does not reset on a checkout of a similarly-named branch", () => {
		const messages = [
			assistantToolCall("1", "edit", { path: "src/lib/foo.ts", edits: [] }),
			toolResult("edit", "1"),
			assistantToolCall("2", "bash", { command: "git checkout main-wip" }),
			toolResult("bash", "2"),
		];
		expect(fold(messages)).toEqual({ phase: "implement", signalId: "1" });
	});

	it("resets to plan on a new branch, including a kanban claim", () => {
		const messages = [
			assistantToolCall("1", "bash", { command: "kanban-md move 507 in-progress --claim storm-dune && git checkout -b feature/507-x" }),
			toolResult("bash", "1"),
		];
		expect(fold(messages)).toEqual({ phase: "plan", signalId: "1" });
	});

	it("keeps implement when a return to main failed", () => {
		const messages = [
			assistantToolCall("1", "bash", { command: "npm test" }),
			assistantToolCall("2", "bash", { command: "git switch main" }),
			toolResult("bash", "2", true),
			toolResult("bash", "1"),
		];
		expect(fold(messages)).toEqual({ phase: "implement", signalId: "1" });
	});

	it("the latest signal wins: implement after a reset", () => {
		const messages = [
			assistantToolCall("1", "bash", { command: "git checkout main" }),
			toolResult("bash", "1"),
			assistantToolCall("2", "bash", { command: "npx vitest run" }),
		];
		expect(fold(messages)).toEqual({ phase: "implement", signalId: "2" });
	});
});

function projectWithSettings(settings: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "dyna-"));
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi/settings.json"), JSON.stringify(settings));
	return dir;
}

describe("readConfig", () => {
	it("defaults: GLM plan/flash implement, implement thinking high, plan thinking pass-through", () => {
		const config = readConfig(join(tmpdir(), "dyna-none"));
		expect(config.plan).toBe("neural-watt/glm-5.3");
		expect(config.implement).toBe("neural-watt/glm-5.3-flash");
		expect(config.implementThinking).toBe("high");
		expect(config.planThinking).toBeUndefined();
		expect(config.resetCommand.test("git checkout main")).toBe(true);
		expect(config.resetCommand.test("git switch master")).toBe(true);
		expect(config.resetCommand.test("git checkout develop")).toBe(false);
	});

	it("reads the dynaModel key from the project's .pi/settings.json", () => {
		const dir = projectWithSettings({ dynaModel: { implementThinking: "low", planThinking: "high", implement: "neural-watt/glm-5.3-flex" } });
		try {
			const config = readConfig(dir);
			expect(config.implement).toBe("neural-watt/glm-5.3-flex");
			expect(config.implementThinking).toBe("low");
			expect(config.planThinking).toBe("high");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("builds the reset matcher from configured trunk branches", () => {
		const dir = projectWithSettings({ dynaModel: { resetBranches: ["develop", "release/next"] } });
		try {
			const config = readConfig(dir);
			expect(config.resetCommand.test("git switch develop && git merge feature/x")).toBe(true);
			expect(config.resetCommand.test("git checkout release/next")).toBe(true);
			expect(config.resetCommand.test("git checkout main")).toBe(false);
			expect(config.resetCommand.test("git checkout develop-wip")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("drops invalid resetBranches values and keeps defaults", () => {
		const dir = projectWithSettings({ dynaModel: { resetBranches: ["develop", "", 42] } });
		try {
			const config = readConfig(dir);
			expect(config.resetCommand.test("git checkout main")).toBe(true);
			expect(config.resetCommand.test("git checkout develop")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("drops invalid values and keeps defaults", () => {
		const dir = projectWithSettings({ dynaModel: { planThinking: "turbo", implement: "no-slash" } });
		try {
			const config = readConfig(dir);
			expect(config.planThinking).toBeUndefined();
			expect(config.implement).toBe("neural-watt/glm-5.3-flash");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
