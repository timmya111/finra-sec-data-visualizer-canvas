import {
	DEFAULT_LOCAL_AI_MODEL,
	filterFreeLocalOllamaModels,
	getOllamaBaseUrl,
	ollamaChat,
	ollamaTags,
} from '@/lib/localAi/ollama';

export const LOCAL_AI_AUTO_MODEL = 'auto';

/** Models that are free/local but not useful as the chat+tools worker. */
const NON_CHAT_MODEL_RE = /(embed|nomic-embed|whisper|tts|clip)/i;

export type LocalAiWorkerRole = 'tools' | 'reason' | 'fetch' | 'critique';

export type LocalAiWorkerPlan = {
	id: string;
	role: LocalAiWorkerRole;
	model: string;
	focus: string;
	useTools: boolean;
};

export type LocalAiRouteDecision = {
	mode: 'auto' | 'manual';
	/** Primary model (single path, or merge/first worker for display). */
	model: string;
	reason: string;
	routerModel?: string;
	candidates: string[];
	pipeline?: 'single' | 'multi';
	workers?: LocalAiWorkerPlan[];
	mergeModel?: string;
};

const TOOLISH_RE =
	/\b(crd|firm|roster|dual|bridge|timeline|employment|canvas|graph|node|fetch|url|brokercheck|adviserinfo|list people|who is)\b/i;
const HARD_RE =
	/\b(compar|analy[sz]e|explain why|synthesize|multi[- ]step|strategy|cross[- ]ref|reconcile|debate|summarize (all|everything)|complex|versus|vs\.?)\b/i;
const URL_RE = /https?:\/\/[^\s]+/i;

export function isLocalAiChatModel(name: string): boolean {
	const n = String(name || '').trim();
	if (!n) return false;
	if (NON_CHAT_MODEL_RE.test(n)) return false;
	return true;
}

export function listAutoChatCandidates(installed: string[]): string[] {
	const free = filterFreeLocalOllamaModels(installed).filter(isLocalAiChatModel);
	const prefer = ['qwen2.5:7b', 'qwen2.5:14b', 'qwen3.6:latest', 'llama3.2:latest', 'gemma4:26b'];
	const ordered = [...prefer.filter((m) => free.includes(m)), ...free.filter((m) => !prefer.includes(m))];
	return ordered;
}

function pickAvailable(candidates: string[], preferred: string[], fallback: string): string {
	for (const p of preferred) {
		if (candidates.includes(p)) return p;
	}
	return candidates[0] || fallback;
}

function toolsModelOf(candidates: string[]): string {
	return pickAvailable(candidates, ['qwen2.5:7b', 'qwen3.6:latest', 'llama3.2:latest'], DEFAULT_LOCAL_AI_MODEL);
}

function reasonModelOf(candidates: string[]): string {
	return pickAvailable(candidates, ['qwen2.5:14b', 'gemma4:26b', 'qwen3.6:latest', 'qwen2.5:7b'], toolsModelOf(candidates));
}

function shouldHeuristicMulti(question: string): boolean {
	const q = String(question || '');
	if (URL_RE.test(q) && TOOLISH_RE.test(q)) return true;
	if (HARD_RE.test(q) && TOOLISH_RE.test(q)) return true;
	if (HARD_RE.test(q) && URL_RE.test(q)) return true;
	return false;
}

function buildMultiPlan(question: string, candidates: string[], reason: string, routerModel?: string): LocalAiRouteDecision {
	const toolsModel = toolsModelOf(candidates);
	const reasonModel = reasonModelOf(candidates);
	const hasUrl = URL_RE.test(question);
	const workers: LocalAiWorkerPlan[] = [
		{
			id: 'w1',
			role: hasUrl ? 'fetch' : 'tools',
			model: toolsModel,
			focus: hasUrl ?
				'Use tools (including fetch_url) to gather local roster/Redis facts and any allowlisted URL details.'
			:	'Use tools to gather exact CRD/roster/timeline/canvas facts. Do not invent.',
			useTools: true,
		},
		{
			id: 'w2',
			role: 'reason',
			model: reasonModel,
			focus:
				'Using the facts from the tools worker, analyze/compare/cross-check. Flag gaps or conflicts. Do not invent CRDs.',
			useTools: false,
		},
	];
	return {
		mode: 'auto',
		pipeline: 'multi',
		model: reasonModel,
		mergeModel: reasonModel,
		workers,
		reason,
		routerModel,
		candidates,
	};
}

/** Fast deterministic route when the LLM planner is skipped or fails. */
export function heuristicRouteModel(question: string, candidates: string[]): LocalAiRouteDecision {
	const q = String(question || '');
	const toolsModel = toolsModelOf(candidates);
	const reasonModel = reasonModelOf(candidates);

	if (shouldHeuristicMulti(q)) {
		return buildMultiPlan(q, candidates, 'heuristic: adaptive multi — tools/fetch + reason + merge', undefined);
	}
	if (HARD_RE.test(q)) {
		return {
			mode: 'auto',
			pipeline: 'single',
			model: reasonModel,
			reason: 'heuristic: open-ended / analytical question → stronger single model',
			candidates,
		};
	}
	return {
		mode: 'auto',
		pipeline: 'single',
		model: toolsModel,
		reason: 'heuristic: tool / roster / timeline style question → fast single tools model',
		candidates,
	};
}

function parseJsonObject(content: string): Record<string, unknown> | null {
	const raw = String(content || '').trim();
	if (!raw) return null;
	const fenced = raw.match(/\{[\s\S]*\}/);
	const slice = fenced ? fenced[0] : raw;
	try {
		const parsed = JSON.parse(slice);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function normalizeWorkerRole(value: unknown): LocalAiWorkerRole {
	const r = String(value || '').trim().toLowerCase();
	if (r === 'fetch' || r === 'critique' || r === 'reason' || r === 'tools') return r;
	return 'tools';
}

function sanitizePlannerPlan(
	parsed: Record<string, unknown>,
	question: string,
	candidates: string[],
	routerModel: string,
): LocalAiRouteDecision | null {
	const mode = String(parsed.mode || '').trim().toLowerCase();
	const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : 'planner decision';

	if (mode === 'single') {
		const model =
			typeof parsed.model === 'string' && candidates.includes(parsed.model.trim()) ?
				parsed.model.trim()
			:	heuristicRouteModel(question, candidates).model;
		return {
			mode: 'auto',
			pipeline: 'single',
			model,
			reason,
			routerModel,
			candidates,
		};
	}

	if (mode === 'pipeline' || mode === 'multi') {
		const rawWorkers = Array.isArray(parsed.workers) ? parsed.workers : [];
		const workers: LocalAiWorkerPlan[] = [];
		for (let i = 0; i < rawWorkers.length && workers.length < 2; i++) {
			const w = rawWorkers[i];
			if (!w || typeof w !== 'object') continue;
			const rec = w as Record<string, unknown>;
			const role = normalizeWorkerRole(rec.role);
			const preferred =
				role === 'reason' || role === 'critique' ?
					[String(rec.model || ''), ...['qwen2.5:14b', 'gemma4:26b', 'qwen3.6:latest', 'qwen2.5:7b']]
				:	[String(rec.model || ''), ...['qwen2.5:7b', 'qwen3.6:latest', 'llama3.2:latest']];
			const model = pickAvailable(candidates, preferred.filter(Boolean), toolsModelOf(candidates));
			workers.push({
				id: `w${workers.length + 1}`,
				role,
				model,
				focus: String(rec.focus || rec.task || '').trim() || `${role} worker`,
				useTools: rec.useTools === false ? false : role === 'reason' || role === 'critique' ? false : true,
			});
		}
		if (workers.length < 2) {
			// Planner asked for multi but under-specified — fall back to heuristic multi only if adaptive says so.
			if (shouldHeuristicMulti(question)) {
				return buildMultiPlan(question, candidates, reason || 'planner multi (completed by heuristic)', routerModel);
			}
			return {
				mode: 'auto',
				pipeline: 'single',
				model: reasonModelOf(candidates),
				reason: `${reason} (planner multi incomplete → single)`,
				routerModel,
				candidates,
			};
		}
		const mergeModel =
			typeof parsed.mergeModel === 'string' && candidates.includes(parsed.mergeModel.trim()) ?
				parsed.mergeModel.trim()
			:	reasonModelOf(candidates);
		return {
			mode: 'auto',
			pipeline: 'multi',
			model: mergeModel,
			mergeModel,
			workers,
			reason,
			routerModel,
			candidates,
		};
	}

	return null;
}

/**
 * Orchestrator planner: adaptive single specialist vs tools/fetch + reason + merge.
 * Caps at 2 workers. Falls back to heuristics if the planner call fails.
 */
export async function routeLocalAiModel(options: {
	question: string;
	availableModels?: string[];
	forceModel?: string | null;
}): Promise<LocalAiRouteDecision> {
	const forced = String(options.forceModel || '').trim();
	if (forced && forced !== LOCAL_AI_AUTO_MODEL) {
		return {
			mode: 'manual',
			pipeline: 'single',
			model: forced,
			reason: 'manual model selection',
			candidates: [forced],
		};
	}

	let installed = options.availableModels;
	if (!installed?.length) {
		const tags = await ollamaTags(getOllamaBaseUrl());
		installed = tags.models;
	}
	const candidates = listAutoChatCandidates(installed || []);
	const fallback = heuristicRouteModel(options.question, candidates);
	const routerModel = pickAvailable(candidates, ['qwen2.5:7b', 'llama3.2:latest', 'qwen3.6:latest'], DEFAULT_LOCAL_AI_MODEL);

	try {
		const { message } = await ollamaChat({
			model: routerModel,
			messages: [
				{
					role: 'system',
					content: `You are a planner for a local FINRA multi-model agent. Choose ONE path.

Prefer mode "single" for simple roster/timeline/canvas lookups.
Use mode "pipeline" only when the question needs both tool facts AND analysis/cross-check (e.g. compare clusters, reconcile a pasted URL with local CRDs, multi-part synthesis). Max 2 workers.

Worker roles: tools|fetch (useTools true, prefer qwen2.5:7b), reason|critique (useTools false, prefer qwen2.5:14b).
mergeModel should be a strong free model (prefer qwen2.5:14b).

Reply JSON only, one of:
{"mode":"single","model":"<name>","reason":"<short>"}
{"mode":"pipeline","reason":"<short>","mergeModel":"<name>","workers":[{"role":"tools","model":"<name>","focus":"<task>","useTools":true},{"role":"reason","model":"<name>","focus":"<task>","useTools":false}]}`,
				},
				{
					role: 'user',
					content: `Candidates:\n${candidates.map((m) => `- ${m}`).join('\n')}\n\nQuestion:\n${String(options.question || '').trim()}`,
				},
			],
		});
		const parsed = parseJsonObject(String(message.content || ''));
		if (parsed) {
			const plan = sanitizePlannerPlan(parsed, options.question, candidates, routerModel);
			if (plan) {
				// Adaptive guard: if planner asked for multi on a clearly simple tool question, collapse to single.
				if (plan.pipeline === 'multi' && !shouldHeuristicMulti(options.question) && !HARD_RE.test(options.question)) {
					return {
						mode: 'auto',
						pipeline: 'single',
						model: toolsModelOf(candidates),
						reason: `${plan.reason} (adaptive: collapsed multi → single tools)`,
						routerModel,
						candidates,
					};
				}
				return plan;
			}
		}
	} catch {
		/* heuristic fallback */
	}

	return { ...fallback, routerModel };
}
