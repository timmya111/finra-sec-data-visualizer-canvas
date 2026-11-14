import {
	DEFAULT_LOCAL_AI_MODEL,
	normalizeToolCallArguments,
	ollamaChat,
	type OllamaChatMessage,
} from '@/lib/localAi/ollama';
import { LOCAL_AI_TOOL_DEFINITIONS, runLocalAiTool } from '@/lib/localAi/tools';

const SYSTEM_PROMPT = `You are a local FINRA graph research assistant for the developer of this app.
You answer questions about person/firm CRDs, current dual-firm bridges, and employment timelines.

Rules:
- Use tools for facts. Do not invent CRDs, firm names, or dates.
- Prefer current/active connections unless the user asks about previous employment.
- When listing people, use the format: Name :: CRD# 1234567
- If a tool returns no matches, say so clearly and suggest a narrower query.
- Keep answers concise. Lead with the list or conclusion, then brief notes.
- Known cluster helpers:
  - Eaton Vance: 104859, 37731, 8039
  - Morgan Stanley: 149777, 8209, 7556, 30344, 30992
  - Deutsche Bank Securities: 2525
`;

export type LocalAiAgentResult = {
	ok: boolean;
	model: string;
	answer: string;
	messages: OllamaChatMessage[];
	toolTrace: Array<{ tool: string; args: Record<string, unknown>; result: unknown }>;
	error?: string;
};

export async function runLocalAiAgent(options: {
	question: string;
	model?: string;
	history?: OllamaChatMessage[];
	maxRounds?: number;
}): Promise<LocalAiAgentResult> {
	const model = options.model || DEFAULT_LOCAL_AI_MODEL;
	const maxRounds = Math.max(1, Math.min(8, options.maxRounds ?? 5));
	const history = Array.isArray(options.history) ? options.history : [];
	const messages: OllamaChatMessage[] = [
		{ role: 'system', content: SYSTEM_PROMPT },
		...history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content),
		{ role: 'user', content: String(options.question || '').trim() },
	];
	const toolTrace: LocalAiAgentResult['toolTrace'] = [];

	if (!String(options.question || '').trim()) {
		return { ok: false, model, answer: '', messages, toolTrace, error: 'question required' };
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
				};
			}

			for (const call of toolCalls) {
				const toolName = String(call?.function?.name || '').trim();
				const args = normalizeToolCallArguments(call?.function?.arguments);
				const ran = await runLocalAiTool(toolName, args);
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
		};
	} catch (error: any) {
		return {
			ok: false,
			model,
			answer: '',
			messages,
			toolTrace,
			error: error?.message || String(error),
		};
	}
}
