import {
	DEFAULT_LOCAL_AI_MODEL,
	normalizeToolCallArguments,
	ollamaChat,
	type OllamaChatMessage,
} from '@/lib/localAi/ollama';
import type { CanvasSnapshot } from '@/lib/localAi/canvasSnapshot';
import { LOCAL_AI_TOOL_DEFINITIONS, runLocalAiTool } from '@/lib/localAi/tools';

function buildSystemPrompt(snapshot?: CanvasSnapshot | null, aboutNodeGraph = false) {
	const canvasLine =
		aboutNodeGraph && snapshot && snapshot.nodeCount > 0 ?
			`The user checked "Question about node graph". Canvas snapshot attached: source=${snapshot.source}, nodes=${snapshot.nodeCount}, links=${snapshot.linkCount}, people=${snapshot.personCount}, firms=${snapshot.firmCount}. Call inspect_canvas_graph first for this question.`
		: aboutNodeGraph ?
			'The user checked "Question about node graph", but no canvas snapshot is attached (or it is empty). Tell them to keep the graph tab open or restore a session, then ask again.'
		:	'The user did not check "Question about node graph". Do not use inspect_canvas_graph. Answer from firm-roster / Redis tools only.';

	return `You are a local FINRA graph research assistant for the developer of this app.
You answer questions about person/firm CRDs, current dual-firm bridges, employment timelines, and (when enabled) the user's live canvas graph.

Rules:
- Use tools for facts. Do not invent CRDs, firm names, or dates.
- Prefer current/active connections unless the user asks about previous employment.
- Only use inspect_canvas_graph when a canvas snapshot is attached for a node-graph question.
- Use firm_current_roster / find_dual_current_people / people_bridging_firm_sets for BrokerCheck current-roster facts beyond what is drawn.
- person_employment_timeline reads local Redis only. Never request new CRDs; cron hydrates the cache. If a person is missing, say they are not in the local cache.
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
	canvas?: { source?: string; nodeCount?: number; linkCount?: number } | null;
	error?: string;
};

export async function runLocalAiAgent(options: {
	question: string;
	model?: string;
	history?: OllamaChatMessage[];
	maxRounds?: number;
	canvasSnapshot?: CanvasSnapshot | null;
	aboutNodeGraph?: boolean;
}): Promise<LocalAiAgentResult> {
	const model = options.model || DEFAULT_LOCAL_AI_MODEL;
	const maxRounds = Math.max(1, Math.min(8, options.maxRounds ?? 5));
	const history = Array.isArray(options.history) ? options.history : [];
	const aboutNodeGraph = Boolean(options.aboutNodeGraph);
	const canvasSnapshot = aboutNodeGraph ? options.canvasSnapshot || null : null;
	const messages: OllamaChatMessage[] = [
		{ role: 'system', content: buildSystemPrompt(canvasSnapshot, aboutNodeGraph) },
		...history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content),
		{ role: 'user', content: String(options.question || '').trim() },
	];
	const toolTrace: LocalAiAgentResult['toolTrace'] = [];
	const canvasMeta =
		canvasSnapshot ?
			{ source: canvasSnapshot.source, nodeCount: canvasSnapshot.nodeCount, linkCount: canvasSnapshot.linkCount }
		:	null;

	if (!String(options.question || '').trim()) {
		return { ok: false, model, answer: '', messages, toolTrace, canvas: canvasMeta, error: 'question required' };
	}

	try {
		for (let round = 0; round < maxRounds; round++) {
			const { message } = await ollamaChat({
				model,
				messages,
				tools: LOCAL_AI_TOOL_DEFINITIONS,
			});
			messages.push(message);

			const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
			if (!toolCalls.length) {
				return {
					ok: true,
					model,
					answer: String(message.content || '').trim() || '(empty model response)',
					messages,
					toolTrace,
					canvas: canvasMeta,
				};
			}

			for (const call of toolCalls) {
				const toolName = String(call?.function?.name || '').trim();
				const args = normalizeToolCallArguments(call?.function?.arguments);
				const ran = await runLocalAiTool(toolName, args, { canvasSnapshot });
				toolTrace.push({ tool: toolName, args, result: ran.result });
				messages.push({
					role: 'tool',
					tool_name: toolName,
					content: JSON.stringify(ran.result),
				});
			}
		}

		return {
			ok: true,
			model,
			answer:
				'I hit the tool-round limit before a final answer. Check the tool trace and ask a more specific follow-up.',
			messages,
			toolTrace,
			canvas: canvasMeta,
		};
	} catch (error: any) {
		return {
			ok: false,
			model,
			answer: '',
			messages,
			toolTrace,
			canvas: canvasMeta,
			error: error?.message || String(error),
		};
	}
}
