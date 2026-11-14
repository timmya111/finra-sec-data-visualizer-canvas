export const DEFAULT_LOCAL_AI_MODEL = 'qwen2.5:7b';
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export type OllamaChatMessage = {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	tool_calls?: OllamaToolCall[];
	tool_name?: string;
};

export type OllamaToolCall = {
	id?: string;
	function: {
		name: string;
		arguments: Record<string, unknown> | string;
		index?: number;
	};
};

export function getOllamaBaseUrl(): string {
	return String(process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, '');
}

/** Ollama Cloud tags (`*:cloud`) are paid; hide them from the local-ai picker. */
export function isFreeLocalOllamaModel(name: string): boolean {
	const n = String(name || '').trim().toLowerCase();
	if (!n) return false;
	if (n.endsWith(':cloud') || n.includes(':cloud-') || n.includes('/cloud:')) return false;
	return true;
}

export function filterFreeLocalOllamaModels(models: string[]): string[] {
	return (Array.isArray(models) ? models : []).filter(isFreeLocalOllamaModel);
}

export async function ollamaTags(baseUrl = getOllamaBaseUrl()): Promise<{
	ok: boolean;
	models: string[];
	error?: string;
}> {
	try {
		const res = await fetch(`${baseUrl}/api/tags`, { cache: 'no-store' });
		if (!res.ok) return { ok: false, models: [], error: `ollama tags HTTP ${res.status}` };
		const data = await res.json();
		const models = Array.isArray(data?.models) ?
			filterFreeLocalOllamaModels(data.models.map((m: any) => String(m?.name || '')).filter(Boolean))
		:	[];
		return { ok: true, models };
	} catch (error: any) {
		return { ok: false, models: [], error: error?.message || String(error) };
	}
}

export async function ollamaChat(options: {
	model?: string;
	messages: OllamaChatMessage[];
	tools?: unknown[];
	baseUrl?: string;
}): Promise<{
	message: OllamaChatMessage;
	raw: any;
}> {
	const baseUrl = options.baseUrl || getOllamaBaseUrl();
	const model = options.model || DEFAULT_LOCAL_AI_MODEL;
	const res = await fetch(`${baseUrl}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model,
			messages: options.messages,
			tools: options.tools,
			stream: false,
		}),
		cache: 'no-store',
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`ollama chat HTTP ${res.status}: ${text.slice(0, 400)}`);
	}
	const raw = await res.json();
	const message = (raw?.message || { role: 'assistant', content: '' }) as OllamaChatMessage;
	return { message, raw };
}

export function normalizeToolCallArguments(args: Record<string, unknown> | string | undefined): Record<string, unknown> {
	if (!args) return {};
	if (typeof args === 'string') {
		try {
			const parsed = JSON.parse(args);
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}
	return args;
}
