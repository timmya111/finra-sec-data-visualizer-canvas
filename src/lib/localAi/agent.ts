import {
	DEFAULT_LOCAL_AI_MODEL,
	normalizeToolCallArguments,
	ollamaChat,
	type OllamaChatMessage,
} from '@/lib/localAi/ollama';
import type { CanvasSnapshot } from '@/lib/localAi/canvasSnapshot';
import { LOCAL_AI_TOOL_DEFINITIONS, runLocalAiTool } from '@/lib/localAi/tools';
import {
	LOCAL_AI_AUTO_MODEL,
	routeLocalAiModel,
	type LocalAiRouteDecision,
	type LocalAiWorkerPlan,
} from '@/lib/localAi/orchestrator';

function buildSystemPrompt(snapshot?: CanvasSnapshot | null, aboutNodeGraph = false, workerFocus?: string) {
	const canvasLine =
		aboutNodeGraph && snapshot && snapshot.nodeCount > 0 ?
			`The user checked "Question about node graph". Canvas snapshot attached: source=${snapshot.source}, nodes=${snapshot.nodeCount}, links=${snapshot.linkCount}, people=${snapshot.personCount}, firms=${snapshot.firmCount}. Call inspect_canvas_graph first for this question.`
		: aboutNodeGraph ?
			'The user checked "Question about node graph", but no canvas snapshot is attached (or it is empty). Tell them to keep the graph tab open or restore a session, then ask again.'
		:	'The user did not check "Question about node graph". Do not use inspect_canvas_graph. Answer from firm-roster / Redis tools only.';

	const focusLine = workerFocus ? `\nWorker focus: ${workerFocus}\n` : '';

	return `You are a local FINRA graph research assistant for the developer of this app.
You answer questions about person/firm CRDs, current dual-firm bridges, employment timelines, and (when enabled) the user's live canvas graph.
${focusLine}
Rules:
- Use tools for facts. Do not invent CRDs, firm names, or dates.
- Prefer current/active connections unless the user asks about previous employment.
- Only use inspect_canvas_graph when a canvas snapshot is attached for a node-graph question.
- Use firm_current_roster / find_dual_current_people / people_bridging_firm_sets for BrokerCheck current-roster facts beyond what is drawn.
- person_employment_timeline reads local Redis only. Never request new CRDs; cron hydrates the cache. If a person is missing, say they are not in the local cache.
- When the user pastes an API endpoint or page URL for cross-reference, call fetch_url with that URL. Only allowlisted hosts work (localhost, BrokerCheck, AdviserInfo, this app). Do not invent page contents.
- For yearly CRD/people/firm counts or charts (all years or a range), call people_crd_year_stats once (defaults to every year). Never refuse as "too large". The UI renders the chart — reply with a short summary (unique people/firms + window totals + year min/max). Do NOT paste the full multi-decade table into the chat. If asked about early years like 1900: firm rows use corporate formedDate (e.g. Stifel 02/20/1900), not CRD issuance.
- When listing people, use the format: Name :: CRD# 1234567
- If a tool returns no matches, say so clearly and suggest a narrower query.
- Keep answers concise. Lead with the list or conclusion, then brief notes.
- Known cluster helpers:
  - Eaton Vance: 104859, 37731, 8039
  - Morgan Stanley: 149777, 8209, 7556, 30344, 30992
  - Deutsche Bank Securities: 2525

${canvasLine}`;
}

export type LocalAiAgentResult = {
	ok: boolean;
	model: string;
	answer: string;
	messages: OllamaChatMessage[];
	toolTrace: Array<{ tool: string; args: Record<string, unknown>; result: unknown }>;
	route?: LocalAiRouteDecision | null;
	workerTraces?: Array<{
		id: string;
		role: string;
		model: string;
		answer: string;
		toolTrace: LocalAiAgentResult['toolTrace'];
	}>;
	canvas?: { source?: string; nodeCount?: number; linkCount?: number } | null;
	error?: string;
};

async function runToolAgentLoop(options: {
	model: string;
	question: string;
	history: OllamaChatMessage[];
	maxRounds: number;
	canvasSnapshot: CanvasSnapshot | null;
	aboutNodeGraph: boolean;
	useTools: boolean;
	workerFocus?: string;
	priorContext?: string;
}): Promise<{
	ok: boolean;
	answer: string;
	messages: OllamaChatMessage[];
	toolTrace: LocalAiAgentResult['toolTrace'];
	error?: string;
}> {
	const userContent =
		options.priorContext ?
			`${options.question}\n\n---\nPrior worker findings (use as evidence; do not invent beyond this + tools):\n${options.priorContext}`
		:	options.question;

	const messages: OllamaChatMessage[] = [
		{
			role: 'system',
			content: buildSystemPrompt(options.canvasSnapshot, options.aboutNodeGraph, options.workerFocus),
		},
		...options.history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content),
		{ role: 'user', content: userContent },
	];
	const toolTrace: LocalAiAgentResult['toolTrace'] = [];

	try {
		for (let round = 0; round < options.maxRounds; round++) {
			const { message } = await ollamaChat({
				model: options.model,
				messages,
				tools: options.useTools ? LOCAL_AI_TOOL_DEFINITIONS : undefined,
			});
			messages.push(message);

			const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
			if (!toolCalls.length || !options.useTools) {
				return {
					ok: true,
					answer: String(message.content || '').trim() || '(empty model response)',
					messages,
					toolTrace,
				};
			}

			for (const call of toolCalls) {
				const toolName = String(call?.function?.name || '').trim();
				const args = normalizeToolCallArguments(call?.function?.arguments);
				const ran = await runLocalAiTool(toolName, args, { canvasSnapshot: options.canvasSnapshot });
				toolTrace.push({ tool: toolName, args, result: ran.result });
				// Slim year-stats payload for the model (full result stays in toolTrace for the UI/chart).
				let toolContent: unknown = ran.result;
				if (toolName === 'people_crd_year_stats' && ran.result && typeof ran.result === 'object') {
					const full = ran.result as Record<string, unknown>;
					toolContent = {
						ok: full.ok,
						fromYear: full.fromYear,
						toYear: full.toYear,
						yearCount: full.yearCount,
						uniquePeopleInCache: full.uniquePeopleInCache,
						uniqueFirmsInCache: full.uniqueFirmsInCache,
						totalsInWindow: full.totalsInWindow,
						chart: full.chart,
						definitions: full.definitions,
						note: 'Full byYear table omitted here. UI shows the chart. Summarize totals only; do not reprint every year.',
					};
				}
				messages.push({
					role: 'tool',
					tool_name: toolName,
					content: JSON.stringify(toolContent),
				});
			}
		}

		return {
			ok: true,
			answer:
				'I hit the tool-round limit before a final answer. Check the tool trace and ask a more specific follow-up.',
			messages,
			toolTrace,
		};
	} catch (error: any) {
		return {
			ok: false,
			answer: '',
			messages,
			toolTrace,
			error: error?.message || String(error),
		};
	}
}

async function mergeWorkerAnswers(options: {
	question: string;
	mergeModel: string;
	workers: Array<{ id: string; role: string; model: string; answer: string }>;
}): Promise<{ ok: boolean; answer: string; error?: string }> {
	const blocks = options.workers
		.map(
			(w, i) =>
				`### Worker ${i + 1} (${w.id}, role=${w.role}, model=${w.model})\n${w.answer || '(empty)'}`,
		)
		.join('\n\n');
	try {
		const { message } = await ollamaChat({
			model: options.mergeModel,
			messages: [
				{
					role: 'system',
					content: `You merge specialist worker answers into one final reply for a FINRA local research assistant.
Rules:
- Prefer concrete tool facts (CRDs, names, dates, rosters) over speculation.
- Resolve conflicts explicitly; if workers disagree, say so and prefer tool-backed claims.
- Do not invent CRDs or firms absent from the worker findings.
- Keep the answer concise. Lead with the list or conclusion, then brief notes.
- Person lines: Name :: CRD# 1234567`,
				},
				{
					role: 'user',
					content: `Original question:\n${options.question}\n\nWorker findings:\n${blocks}\n\nWrite the final merged answer.`,
				},
			],
		});
		return { ok: true, answer: String(message.content || '').trim() || '(empty merge response)' };
	} catch (error: any) {
		return { ok: false, answer: '', error: error?.message || String(error) };
	}
}

export async function runLocalAiAgent(options: {
	question: string;
	model?: string;
	history?: OllamaChatMessage[];
	maxRounds?: number;
	canvasSnapshot?: CanvasSnapshot | null;
	aboutNodeGraph?: boolean;
	availableModels?: string[];
}): Promise<LocalAiAgentResult> {
	const requested = String(options.model || LOCAL_AI_AUTO_MODEL).trim() || LOCAL_AI_AUTO_MODEL;
	const route = await routeLocalAiModel({
		question: options.question,
		availableModels: options.availableModels,
		forceModel: requested === LOCAL_AI_AUTO_MODEL ? null : requested,
	});
	const maxRounds = Math.max(1, Math.min(8, options.maxRounds ?? 5));
	const history = Array.isArray(options.history) ? options.history : [];
	const aboutNodeGraph = Boolean(options.aboutNodeGraph);
	const canvasSnapshot = aboutNodeGraph ? options.canvasSnapshot || null : null;
	const canvasMeta =
		canvasSnapshot ?
			{ source: canvasSnapshot.source, nodeCount: canvasSnapshot.nodeCount, linkCount: canvasSnapshot.linkCount }
		:	null;

	if (!String(options.question || '').trim()) {
		return {
			ok: false,
			model: route.model || DEFAULT_LOCAL_AI_MODEL,
			answer: '',
			messages: [],
			toolTrace: [],
			route,
			canvas: canvasMeta,
			error: 'question required',
		};
	}

	const workers: LocalAiWorkerPlan[] =
		route.pipeline === 'multi' && Array.isArray(route.workers) && route.workers.length >= 2 ?
			route.workers.slice(0, 2)
		:	[];

	// Single-specialist path (manual, or adaptive single).
	if (!workers.length) {
		const model = route.model || DEFAULT_LOCAL_AI_MODEL;
		const ran = await runToolAgentLoop({
			model,
			question: options.question,
			history,
			maxRounds,
			canvasSnapshot,
			aboutNodeGraph,
			useTools: true,
		});
		return {
			ok: ran.ok,
			model,
			answer: ran.answer,
			messages: ran.messages,
			toolTrace: ran.toolTrace,
			route,
			canvas: canvasMeta,
			error: ran.error,
		};
	}

	// Multi path: sequential workers (later workers see earlier findings), then merge.
	const workerTraces: NonNullable<LocalAiAgentResult['workerTraces']> = [];
	const allToolTrace: LocalAiAgentResult['toolTrace'] = [];
	let prior = '';
	let lastMessages: OllamaChatMessage[] = [];

	for (const worker of workers) {
		const ran = await runToolAgentLoop({
			model: worker.model,
			question: options.question,
			history,
			maxRounds: worker.useTools ? maxRounds : Math.min(3, maxRounds),
			canvasSnapshot,
			aboutNodeGraph,
			useTools: worker.useTools,
			workerFocus: worker.focus,
			priorContext: prior || undefined,
		});
		workerTraces.push({
			id: worker.id,
			role: worker.role,
			model: worker.model,
			answer: ran.answer || ran.error || '',
			toolTrace: ran.toolTrace,
		});
		allToolTrace.push(...ran.toolTrace.map((t) => ({ ...t, args: { ...t.args, _worker: worker.id } })));
		lastMessages = ran.messages;
		prior = [prior, `## ${worker.id} (${worker.role} / ${worker.model})\n${ran.answer || ran.error || ''}`]
			.filter(Boolean)
			.join('\n\n');
		if (!ran.ok && !ran.answer) {
			// Continue so merge can still use partial findings when possible.
		}
	}

	const mergeModel = route.mergeModel || route.model || DEFAULT_LOCAL_AI_MODEL;
	const merged = await mergeWorkerAnswers({
		question: options.question,
		mergeModel,
		workers: workerTraces.map((w) => ({
			id: w.id,
			role: w.role,
			model: w.model,
			answer: w.answer,
		})),
	});

	if (!merged.ok) {
		// Fall back to concatenating worker answers if merge fails.
		const fallbackAnswer = workerTraces
			.map((w) => `### ${w.role} (${w.model})\n${w.answer}`)
			.join('\n\n');
		return {
			ok: Boolean(fallbackAnswer.trim()),
			model: mergeModel,
			answer: fallbackAnswer || '',
			messages: lastMessages,
			toolTrace: allToolTrace,
			route,
			workerTraces,
			canvas: canvasMeta,
			error: merged.error,
		};
	}

	return {
		ok: true,
		model: mergeModel,
		answer: merged.answer,
		messages: lastMessages,
		toolTrace: allToolTrace,
		route,
		workerTraces,
		canvas: canvasMeta,
	};
}
