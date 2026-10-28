/**
 * omo-langsmith: send OmO Native (senpi) agent activity to LangSmith.
 *
 * Trace layout (one LangSmith trace per user prompt, grouped into a Thread per OmO session):
 *
 *   omo.agent  (chain)   one per prompt; metadata.session_id/thread_id = OmO session id
 *   └─ turn N  (chain)   one per turn (one model reply + the tools it called)
 *      ├─ <model> (llm)  inputs = recent context messages, outputs = assistant message + usage_metadata
 *      └─ <tool>  (tool) one per tool call (nested tool calls go under their parent tool run)
 *
 * Config (environment variables, read when the session starts):
 *   LANGSMITH_API_KEY              required; without it the extension does nothing
 *   LANGSMITH_PROJECT              project name (project-based workspaces), default "default"
 *   LANGSMITH_AGENT_ID / LANGSMITH_AGENT_ENVIRONMENT
 *                                  agent-based workspaces instead of a project (set both, not with PROJECT)
 *   LANGSMITH_ENDPOINT             default https://api.smith.langchain.com (EU: https://eu.api.smith.langchain.com)
 *   LANGSMITH_WORKSPACE_ID         only if the key spans several workspaces
 *   OMO_LANGSMITH_DISABLED=1       turn off without removing the file
 *   OMO_LANGSMITH_MAX_INPUT_MESSAGES  context messages sent per llm run (default 30, 0 = all)
 *   OMO_LANGSMITH_MAX_CHARS        cap per text field (default 20000)
 *   OMO_LANGSMITH_SYSTEM_PROMPT=1  also send the (large) system prompt on each agent run
 *   OMO_LANGSMITH_THINKING=0       drop model thinking/reasoning text
 *   OMO_LANGSMITH_REDACT=0         skip senpi's /share redactor (default: on)
 *
 * Install: copy this folder to ~/.omo/agent/extensions/omo-langsmith/, run `bun install` (or npm install)
 * inside it, then /reload in omo.
 */
import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { Client, RunTree } from "langsmith";

type Json = Record<string, unknown>;

const env = (k: string): string | undefined => {
	const v = process.env[k]?.trim();
	return v ? v : undefined;
};
const intEnv = (k: string, d: number): number => {
	const n = Number.parseInt(env(k) ?? "", 10);
	return Number.isFinite(n) && n >= 0 ? n : d;
};

export default function omoLangsmith(pi: ExtensionAPI) {
	if (!env("LANGSMITH_API_KEY") || env("OMO_LANGSMITH_DISABLED") === "1") return;

	const MAX_INPUT_MESSAGES = intEnv("OMO_LANGSMITH_MAX_INPUT_MESSAGES", 30);
	const MAX_CHARS = intEnv("OMO_LANGSMITH_MAX_CHARS", 20000);
	const SEND_SYSTEM = env("OMO_LANGSMITH_SYSTEM_PROMPT") === "1";
	const SEND_THINKING = env("OMO_LANGSMITH_THINKING") !== "0";
	const REDACT = env("OMO_LANGSMITH_REDACT") !== "0";

	let client: Client | undefined;
	let sessionId = "unknown";
	let cwd = "";
	let agentRun: RunTree | undefined;
	let turnRun: RunTree | undefined;
	let llmRun: RunTree | undefined;
	let llmFirstToken = false;
	let lastContext: unknown[] | undefined;
	let pendingPrompt: { prompt: string; trigger: string; systemPrompt?: string } | undefined;
	const toolRuns = new Map<string, RunTree>();

	// ---------- helpers ----------
	const warn = (where: string, err: unknown) => {
		if (env("OMO_LANGSMITH_DEBUG") === "1") console.error(`[omo-langsmith] ${where}:`, err);
	};
	/** Fire-and-forget: tracing must never block or break the agent. */
	const bg = (where: string, p: Promise<unknown> | undefined) => {
		p?.catch((e) => warn(where, e));
	};
	const clean = (s: string): string => {
		let t = s;
		if (REDACT) {
			try {
				t = pi.redactForUpload(t).text;
			} catch (e) {
				warn("redact", e);
			}
		}
		return MAX_CHARS > 0 && t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS)}… [truncated ${t.length - MAX_CHARS} chars]` : t;
	};
	const cleanJson = (v: unknown): unknown => {
		if (v === undefined) return undefined;
		try {
			const s = typeof v === "string" ? v : JSON.stringify(v);
			const c = clean(s ?? "");
			if (typeof v === "string") return c;
			try {
				return JSON.parse(c);
			} catch {
				return c; // truncated JSON stays a string
			}
		} catch {
			return String(v);
		}
	};

	/** senpi content block -> LangChain-style content block. */
	const block = (b: any): Json | undefined => {
		switch (b?.type) {
			case "text":
				return { type: "text", text: clean(String(b.text ?? "")) };
			case "thinking":
				return SEND_THINKING && b.thinking ? { type: "reasoning", text: clean(String(b.thinking)) } : undefined;
			case "toolCall":
				return { type: "tool_call", id: b.id, name: b.name, args: cleanJson(b.arguments ?? {}) };
			case "image":
				return { type: "text", text: `[${b.mimeType ?? "image"} omitted]` };
			case "providerNative":
				return { type: "text", text: `[provider-native ${b.subtype ?? ""} block]` };
			default:
				return undefined;
		}
	};
	const blocks = (content: unknown): Json[] =>
		typeof content === "string"
			? [{ type: "text", text: clean(content) }]
			: Array.isArray(content)
				? (content.map(block).filter(Boolean) as Json[])
				: [];

	/** senpi AgentMessage -> LangChain-format message (role/content). Custom roles become user text. */
	const toLsMessage = (m: any): Json | undefined => {
		if (!m || typeof m !== "object") return undefined;
		switch (m.role) {
			case "user":
				return { role: "user", content: blocks(m.content) };
			case "assistant":
				return { role: "assistant", content: blocks(m.content) };
			case "toolResult":
				return { role: "tool", tool_call_id: m.toolCallId, name: m.toolName, content: blocks(m.content) };
			default: {
				const c = blocks(m.content);
				return c.length ? { role: "user", content: c, senpi_role: m.role } : undefined;
			}
		}
	};

	const usageMetadata = (u: any): Json | undefined => {
		if (!u) return undefined;
		const input = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		const out: Json = {
			input_tokens: input,
			output_tokens: u.output ?? 0,
			total_tokens: u.totalTokens ?? input + (u.output ?? 0),
			input_token_details: { cache_read: u.cacheRead ?? 0, cache_creation: u.cacheWrite ?? 0 },
		};
		if (typeof u.reasoning === "number") out.output_token_details = { reasoning: u.reasoning };
		// senpi already prices the call; pass it through unless the model has no known price.
		if (u.cost && !u.costUnknown) {
			out.input_cost = (u.cost.input ?? 0) + (u.cost.cacheRead ?? 0) + (u.cost.cacheWrite ?? 0);
			out.output_cost = u.cost.output ?? 0;
			out.total_cost = u.cost.total ?? 0;
		}
		return out;
	};

	const lastAssistantText = (messages: any[] | undefined): string | undefined => {
		for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
			const m = messages![i];
			if (m?.role === "assistant") {
				const t = (Array.isArray(m.content) ? m.content : [])
					.filter((b: any) => b?.type === "text")
					.map((b: any) => b.text)
					.join("\n");
				if (t) return clean(t);
			}
		}
		return undefined;
	};

	const start = (run: RunTree) => {
		bg("postRun", run.postRun());
		return run;
	};
	const finish = (run: RunTree | undefined, outputs?: Json, error?: string) => {
		if (!run || run.end_time) return;
		bg(
			"end",
			run.end(outputs, error).then(() => run.patchRun()),
		);
	};

	const closeLlm = (error?: string) => {
		finish(llmRun, undefined, error);
		llmRun = undefined;
	};
	const closeTools = (error?: string) => {
		for (const r of toolRuns.values()) finish(r, undefined, error);
		toolRuns.clear();
	};
	const closeTurn = (outputs?: Json, error?: string) => {
		closeLlm(error);
		closeTools(error);
		finish(turnRun, outputs, error);
		turnRun = undefined;
	};
	const closeAgent = (outputs?: Json, error?: string) => {
		closeTurn(undefined, error);
		finish(agentRun, outputs, error);
		agentRun = undefined;
	};

	const ensureAgentRun = (ctx: ExtensionContext): RunTree | undefined => {
		if (agentRun) return agentRun;
		if (!client) return undefined;
		const p = pendingPrompt;
		pendingPrompt = undefined;
		const inputs: Json = { messages: [{ role: "user", content: [{ type: "text", text: clean(p?.prompt ?? "") }] }] };
		if (p?.systemPrompt) inputs.system = clean(p.systemPrompt);
		agentRun = start(
			new RunTree({
				name: "omo.agent",
				run_type: "chain",
				client,
				tracingEnabled: true,
				inputs,
				tags: ["omo", ctx.mode ?? "interactive"].filter(Boolean) as string[],
				metadata: {
					session_id: sessionId,
					thread_id: sessionId,
					trigger: p?.trigger,
					cwd,
					senpi_version: pi.hostVersion,
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				},
			}),
		);
		return agentRun;
	};

	// ---------- lifecycle ----------
	pi.on("session_start", async (_event, ctx) => {
		try {
			client = new Client(); // reads LANGSMITH_API_KEY / LANGSMITH_ENDPOINT / LANGSMITH_WORKSPACE_ID
			sessionId = ctx.sessionManager.getSessionId();
			cwd = clean(ctx.cwd);
			ctx.ui.setStatus("langsmith", "LangSmith ●");
		} catch (e) {
			warn("session_start", e);
			client = undefined;
		}
	});

	pi.on(
		"before_agent_start",
		async (event) => {
			if (event.preview === true) return undefined; // prompt-cache preview: no side effects
			pendingPrompt = {
				prompt: event.prompt,
				trigger: event.trigger,
				systemPrompt: SEND_SYSTEM ? event.systemPrompt : undefined,
			};
			return undefined;
		},
		{ previewSafe: true },
	);

	pi.on("agent_start", async (_event, ctx) => {
		try {
			ensureAgentRun(ctx);
		} catch (e) {
			warn("agent_start", e);
		}
	});

	pi.on("turn_start", async (event, ctx) => {
		try {
			const parent = ensureAgentRun(ctx);
			if (!parent) return;
			closeTurn(); // defensive: a turn that never got turn_end
			turnRun = start(
				parent.createChild({
					name: `turn ${event.turnIndex}`,
					run_type: "chain",
					start_time: event.timestamp,
					metadata: { turn_index: event.turnIndex },
				}),
			);
		} catch (e) {
			warn("turn_start", e);
		}
	});

	// Remember what the model is about to see (only the live request, not summarizer projections).
	pi.on(
		"context",
		async (event) => {
			if (event.source === "projection") return undefined;
			lastContext = event.messages as unknown[];
			return undefined;
		},
		{ mutatesMessages: false },
	);

	pi.on("message_start", async (event, ctx) => {
		try {
			const m: any = event.message;
			if (m?.role !== "assistant" || !turnRun) return;
			closeLlm(); // a previous attempt in the same turn (retry) that never ended
			const all = (lastContext ?? []) as any[];
			const recent = MAX_INPUT_MESSAGES > 0 ? all.slice(-MAX_INPUT_MESSAGES) : all;
			const model = ctx.model;
			llmFirstToken = false;
			llmRun = start(
				turnRun.createChild({
					name: model?.id ?? m.model ?? "llm",
					run_type: "llm",
					inputs: { messages: recent.map(toLsMessage).filter(Boolean) },
					metadata: {
						ls_provider: model?.provider ?? m.provider,
						ls_model_name: model?.id ?? m.model,
						context_messages_total: all.length,
						context_messages_sent: recent.length,
						thinking_level: ctx.thinkingLevel,
					},
				}),
			);
		} catch (e) {
			warn("message_start", e);
		}
	});

	pi.on("message_update", async () => {
		if (llmRun && !llmFirstToken) {
			llmFirstToken = true;
			try {
				llmRun.addEvent({ name: "new_token", time: new Date().toISOString() });
			} catch (e) {
				warn("new_token", e);
			}
		}
	});

	pi.on("message_end", async (event) => {
		try {
			const m: any = event.message;
			if (m?.role !== "assistant" || !llmRun) return;
			const run = llmRun;
			llmRun = undefined;
			run.metadata = {
				...run.metadata,
				ls_model_name: m.responseModel ?? m.model ?? run.metadata?.ls_model_name,
				ls_provider: m.provider ?? run.metadata?.ls_provider,
				stop_reason: m.stopReason,
				api: m.api,
			};
			const isError = m.stopReason === "error" || m.stopReason === "aborted";
			finish(
				run,
				{
					messages: [toLsMessage(m)],
					usage_metadata: usageMetadata(m.usage),
				},
				isError ? clean(m.errorMessage ?? m.stopReason) : undefined,
			);
		} catch (e) {
			warn("message_end", e);
		}
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		try {
			const parent =
				(event.parentToolCallId && toolRuns.get(event.parentToolCallId)) || turnRun || ensureAgentRun(ctx);
			if (!parent) return;
			toolRuns.set(
				event.toolCallId,
				start(
					parent.createChild({
						name: event.toolName,
						run_type: "tool",
						inputs: (cleanJson(event.args) as Json) ?? {},
						metadata: { tool_call_id: event.toolCallId, parent_tool_call_id: event.parentToolCallId },
					}),
				),
			);
		} catch (e) {
			warn("tool_execution_start", e);
		}
	});

	pi.on("tool_execution_end", async (event) => {
		try {
			const run = toolRuns.get(event.toolCallId);
			if (!run) return;
			toolRuns.delete(event.toolCallId);
			const r: any = event.result;
			const output = Array.isArray(r?.content) ? blocks(r.content) : cleanJson(r);
			const text = Array.isArray(output)
				? output.map((b: any) => b.text ?? "").join("\n")
				: undefined;
			finish(run, { output }, event.isError ? text?.slice(0, 2000) || "tool error" : undefined);
		} catch (e) {
			warn("tool_execution_end", e);
		}
	});

	pi.on("turn_end", async (event) => {
		try {
			closeTurn({ tool_results: event.toolResults?.length ?? 0 });
		} catch (e) {
			warn("turn_end", e);
		}
	});

	pi.on("agent_end", async (event) => {
		try {
			if (!agentRun) return;
			const answer = lastAssistantText(event.messages as any[]);
			const error = event.aborted ? `aborted${event.abortSource ? ` (${event.abortSource})` : ""}` : undefined;
			if (event.willRetry) agentRun.metadata = { ...agentRun.metadata, will_retry: true };
			closeAgent(answer ? { messages: [{ role: "assistant", content: [{ type: "text", text: answer }] }] } : {}, error);
			lastContext = undefined;
		} catch (e) {
			warn("agent_end", e);
		}
	});

	pi.on("session_shutdown", async (event) => {
		try {
			closeAgent(undefined, agentRun ? `session ${event.reason}` : undefined);
			const c = client;
			client = undefined;
			if (!c) return;
			// Quit budget is ~2 s for all extensions; give the upload at most 1.5 s.
			await Promise.race([
				c.awaitPendingTraceBatches(),
				new Promise<void>((resolve) => {
					const t = setTimeout(resolve, 1500);
					event.signal?.addEventListener("abort", () => {
						clearTimeout(t);
						resolve();
					});
				}),
			]);
		} catch (e) {
			warn("session_shutdown", e);
		}
	});
}
