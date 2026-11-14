import fs from 'fs';
import path from 'path';
import { decompressPayload, getRedisClient } from '@/lib/redisCache';
import { unwrapCachedIndividualDetail } from '@/lib/graphConnections';
import { inspectCanvasSnapshot, type CanvasSnapshot } from '@/lib/localAi/canvasSnapshot';
import { getPeopleCrdYearStats } from '@/lib/localAi/crdYearStats';

const FIRM_CONN_DIR = path.join(process.cwd(), 'data', 'firm-connections');

export type LocalAiToolName =
	| 'inspect_canvas_graph'
	| 'find_dual_current_people'
	| 'firm_current_roster'
	| 'person_employment_timeline'
	| 'people_bridging_firm_sets'
	| 'fetch_url'
	| 'people_crd_year_stats';

export const LOCAL_AI_TOOL_DEFINITIONS = [
	{
		type: 'function' as const,
		function: {
			name: 'inspect_canvas_graph',
			description:
				'Inspect the user\'s currently loaded FINRA canvas graph snapshot (nodes/links on screen or restored session). Use for questions about what is on the graph right now. Actions: summary, list_people, list_firms, selection_log, neighbors, dual_on_canvas, search.',
			parameters: {
				type: 'object',
				properties: {
					action: {
						type: 'string',
						description:
							'summary | list_people | list_firms | selection_log | neighbors | dual_on_canvas | search',
					},
					query: { type: 'string', description: 'Optional name/CRD filter for list/search actions' },
					nodeId: { type: 'string', description: 'Node id for neighbors, e.g. person:5417517 or firm:2525' },
					limit: { type: 'number', description: 'Max rows to return (default 40)' },
				},
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'find_dual_current_people',
			description:
				'Find people who currently appear on 2+ firm current-connection rosters. Use for unique/multi-firm active bridges. Returns Name :: CRD# lines.',
			parameters: {
				type: 'object',
				properties: {
					minFirms: { type: 'number', description: 'Minimum distinct current firms (default 2)' },
					mustIncludeFirmCrd: {
						type: 'string',
						description: 'If set, person must be current at this firm CRD',
					},
					excludeFirmCrds: {
						type: 'array',
						items: { type: 'string' },
						description: 'Ignore these firm CRDs when counting (optional)',
					},
					limit: { type: 'number', description: 'Max people to return (default 40, max 200)' },
				},
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'firm_current_roster',
			description: 'List people currently connected to a firm CRD from local firm-connections data.',
			parameters: {
				type: 'object',
				properties: {
					firmCrd: { type: 'string', description: 'Firm CRD number' },
					limit: { type: 'number', description: 'Max people (default 40, max 200)' },
					query: { type: 'string', description: 'Optional name substring filter' },
				},
				required: ['firmCrd'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'person_employment_timeline',
			description:
				'Get current and previous employment firms with registration begin/end dates for a person CRD from the local Redis cache only. Never fetches new CRDs; if missing, report that the cache lacks this person (cron owns hydration).',
			parameters: {
				type: 'object',
				properties: {
					personCrd: { type: 'string', description: 'Individual CRD number' },
				},
				required: ['personCrd'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'people_bridging_firm_sets',
			description:
				'Find people currently at any firm in set A who are also currently at any firm in set B (or outside set A if B omitted). Useful for Eaton Vance + Morgan Stanley style cluster questions.',
			parameters: {
				type: 'object',
				properties: {
					setAFirmCrds: {
						type: 'array',
						items: { type: 'string' },
						description: 'Cluster firm CRDs (required)',
					},
					setBFirmCrds: {
						type: 'array',
						items: { type: 'string' },
						description: 'Other firm CRDs to bridge into. If omitted, any firm outside set A counts.',
					},
					limit: { type: 'number', description: 'Max people (default 40, max 200)' },
				},
				required: ['setAFirmCrds'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'fetch_url',
			description:
				'GET an API endpoint or page URL the user provided for cross-reference. Returns truncated JSON or text. Allowlisted hosts only (localhost, BrokerCheck, AdviserInfo, this app). Read-only; never writes Redis or hydrates CRDs.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'Absolute http(s) URL to fetch' },
					maxChars: {
						type: 'number',
						description: 'Max characters of body to return (default 24000, max 48000)',
					},
				},
				required: ['url'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'people_crd_year_stats',
			description:
				'Yearly census from local Redis for EVERY year present (default full range). People: first employment registrationBeginDate vs inactive/terminated end year. Firms: corporate formedDate (can be early 1900s — NOT CRD creation) vs firmStatusDate when terminated/inactive. Use for yearly charts/stats. Do NOT refuse or sample — call this tool. Clarify formedDate vs CRD creation if the user asks about 1900. Returns asciiTable + byYear + chart.',
			parameters: {
				type: 'object',
				properties: {
					fromYear: {
						type: 'number',
						description: 'Start year inclusive (default: earliest year in cache)',
					},
					toYear: {
						type: 'number',
						description: 'End year inclusive (default: latest year in cache)',
					},
					includeFirms: {
						type: 'boolean',
						description: 'Include firm new/disabled columns (default true)',
					},
				},
			},
		},
	},
];

const FETCH_URL_DEFAULT_HOSTS = new Set([
	'localhost',
	'127.0.0.1',
	'[::1]',
	'::1',
	'brokercheck.finra.org',
	'api.brokercheck.finra.org',
	'files.brokercheck.finra.org',
	'adviserinfo.sec.gov',
	'api.adviserinfo.sec.gov',
	'finra-sec-data-visualizer-canvas.vercel.app',
]);

const FETCH_URL_MAX_BYTES = 512_000;
const FETCH_URL_TIMEOUT_MS = 15_000;

function fetchUrlAllowedHosts(): Set<string> {
	const hosts = new Set(FETCH_URL_DEFAULT_HOSTS);
	const extra = String(process.env.LOCAL_AI_FETCH_HOSTS || '')
		.split(',')
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean);
	for (const h of extra) hosts.add(h);
	return hosts;
}

function normalizeFetchHost(hostname: string): string {
	return String(hostname || '')
		.trim()
		.toLowerCase()
		.replace(/^\[(.*)\]$/, '$1');
}

function isFetchUrlAllowed(url: URL): { ok: true } | { ok: false; error: string } {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, error: 'only http(s) URLs are allowed' };
	}
	if (url.username || url.password) {
		return { ok: false, error: 'URLs with credentials are not allowed' };
	}
	const host = normalizeFetchHost(url.hostname);
	if (!fetchUrlAllowedHosts().has(host) && !fetchUrlAllowedHosts().has(url.hostname.toLowerCase())) {
		return {
			ok: false,
			error: `host not allowlisted: ${url.hostname}. Allowed: localhost, BrokerCheck, AdviserInfo, app host (or LOCAL_AI_FETCH_HOSTS)`,
		};
	}
	return { ok: true };
}

function htmlToReadableText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

function truncateChars(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: text.slice(0, maxChars), truncated: true };
}

async function fetchUrlForLocalAi(
	rawUrl: unknown,
	maxCharsRaw: unknown,
): Promise<{ ok: boolean; result: Record<string, unknown> }> {
	const maxChars = Math.max(1000, Math.min(48_000, Number(maxCharsRaw) || 24_000));
	let parsed: URL;
	try {
		parsed = new URL(String(rawUrl || '').trim());
	} catch {
		return { ok: false, result: { error: 'invalid URL' } };
	}
	const allowed = isFetchUrlAllowed(parsed);
	if (allowed.ok === false) {
		return { ok: false, result: { error: allowed.error, url: parsed.href } };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_URL_TIMEOUT_MS);
	try {
		const res = await fetch(parsed.href, {
			method: 'GET',
			redirect: 'follow',
			cache: 'no-store',
			signal: controller.signal,
			headers: {
				Accept: 'application/json, text/plain, text/html;q=0.9, */*;q=0.8',
				'User-Agent': 'finra-local-ai-fetch/1.0',
			},
		});
		const finalUrl = new URL(res.url);
		const finalAllowed = isFetchUrlAllowed(finalUrl);
		if (!finalAllowed.ok) {
			return {
				ok: false,
				result: {
					error: `redirect landed on disallowed host: ${finalUrl.hostname}`,
					requestedUrl: parsed.href,
					finalUrl: finalUrl.href,
				},
			};
		}

		const contentType = String(res.headers.get('content-type') || '')
			.split(';')[0]
			.trim()
			.toLowerCase();
		const buf = Buffer.from(await res.arrayBuffer());
		const byteTruncated = buf.length > FETCH_URL_MAX_BYTES;
		const slice = byteTruncated ? buf.subarray(0, FETCH_URL_MAX_BYTES) : buf;
		const rawText = slice.toString('utf8');

		let kind: 'json' | 'text' | 'html' = 'text';
		let body: unknown = rawText;
		const looksJson = contentType.includes('json') || /^\s*[{[]/.test(rawText);
		if (looksJson) {
			try {
				body = JSON.parse(rawText);
				kind = 'json';
			} catch {
				kind = 'text';
				body = rawText;
			}
		} else if (contentType.includes('html') || /^\s*</.test(rawText)) {
			kind = 'html';
			body = htmlToReadableText(rawText);
		}

		const serialized = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
		const { text, truncated } = truncateChars(serialized, maxChars);
		let returnedBody: unknown = text;
		if (kind === 'json') {
			try {
				returnedBody = JSON.parse(text);
			} catch {
				returnedBody = text;
			}
		}

		return {
			ok: res.ok,
			result: {
				ok: res.ok,
				status: res.status,
				contentType: contentType || null,
				kind,
				requestedUrl: parsed.href,
				finalUrl: finalUrl.href,
				byteLength: buf.length,
				truncated: truncated || byteTruncated,
				body: returnedBody,
				hint:
					truncated || byteTruncated ?
						'Body truncated for model context; ask for a narrower URL or field if needed.'
					:	undefined,
			},
		};
	} catch (e: any) {
		const message = e?.name === 'AbortError' ? `timeout after ${FETCH_URL_TIMEOUT_MS}ms` : e?.message || String(e);
		return { ok: false, result: { error: message, url: parsed.href } };
	} finally {
		clearTimeout(timer);
	}
}

function normalizeCrd(value: unknown): string | null {
	const s = String(value ?? '')
		.replace(/^(person:|firm:)/i, '')
		.trim();
	return /^\d+$/.test(s) ? s : null;
}

function personNameFromEntry(entry: Record<string, unknown>): string {
	const direct = entry.name || entry.label || entry.fullName;
	if (direct) return String(direct).trim();
	const parts = [entry.firstName, entry.middleName, entry.lastName].filter(Boolean).map(String);
	return parts.join(' ').trim();
}

function loadFirmCurrentPeople(firmCrd: string): Map<string, string> {
	const file = path.join(FIRM_CONN_DIR, `${firmCrd}.json`);
	const out = new Map<string, string>();
	if (!fs.existsSync(file)) return out;
	try {
		const data = JSON.parse(fs.readFileSync(file, 'utf8'));
		const current = Array.isArray(data?.currentConnections) ? data.currentConnections : [];
		for (const entry of current) {
			if (!entry || typeof entry !== 'object') continue;
			const crd = normalizeCrd((entry as any).individualId ?? (entry as any).crd ?? (entry as any).id);
			if (!crd) continue;
			const name = personNameFromEntry(entry as Record<string, unknown>);
			if (!out.has(crd) || name) out.set(crd, name || out.get(crd) || crd);
		}
	} catch {
		/* ignore bad file */
	}
	return out;
}

function listFirmConnectionCrds(): string[] {
	if (!fs.existsSync(FIRM_CONN_DIR)) return [];
	return fs
		.readdirSync(FIRM_CONN_DIR)
		.filter((name) => name.endsWith('.json'))
		.map((name) => name.slice(0, -5))
		.filter((crd) => /^\d+$/.test(crd));
}

function clampLimit(value: unknown, fallback = 40, max = 200): number {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(max, Math.floor(n));
}

function formatPersonLine(name: string, crd: string): string {
	return `${name || crd} :: CRD# ${crd}`;
}

type PersonFirmIndex = {
	personFirms: Map<string, Set<string>>;
	personNames: Map<string, string>;
	scannedFirms: number;
};

let fullIndexCache: { builtAt: number; index: PersonFirmIndex } | null = null;
const FULL_INDEX_TTL_MS = 5 * 60 * 1000;

/** Build person -> current firm set from disk firm-connections (current only). */
function buildPersonCurrentFirmIndex(options: {
	onlyFirmCrds?: Set<string> | null;
} = {}): PersonFirmIndex {
	if (!options.onlyFirmCrds && fullIndexCache && Date.now() - fullIndexCache.builtAt < FULL_INDEX_TTL_MS) {
		return fullIndexCache.index;
	}

	const personFirms = new Map<string, Set<string>>();
	const personNames = new Map<string, string>();
	const firmCrds = options.onlyFirmCrds ? Array.from(options.onlyFirmCrds) : listFirmConnectionCrds();
	let scanned = 0;
	for (const firmCrd of firmCrds) {
		scanned += 1;
		const people = loadFirmCurrentPeople(firmCrd);
		for (const [crd, name] of people) {
			if (!personFirms.has(crd)) personFirms.set(crd, new Set());
			personFirms.get(crd)!.add(firmCrd);
			if (name) personNames.set(crd, name);
		}
	}
	const index = { personFirms, personNames, scannedFirms: scanned };
	if (!options.onlyFirmCrds) {
		fullIndexCache = { builtAt: Date.now(), index };
	}
	return index;
}

/**
 * Local Redis only. Cron owns CRD hydration — local-ai never calls
 * /api/finra/individual (that route can queue live FINRA/SEC fetches).
 * With USE_LOCAL_REDIS=1, getRedisClient() talks to 127.0.0.1:6379.
 */
async function loadIndividualDetail(personCrd: string): Promise<any | null> {
	const crd = normalizeCrd(personCrd);
	if (!crd) return null;
	try {
		const redis = getRedisClient();
		if (!redis) return null;
		for (const key of [`finra:individual:${crd}`, `sec:individual:${crd}`]) {
			const raw = await redis.get(key);
			if (raw == null) continue;
			const text =
				typeof raw === 'string' && raw.startsWith('br:') ? decompressPayload(raw) : raw;
			const envelope = typeof text === 'string' ? JSON.parse(text) : text;
			const detail = unwrapCachedIndividualDetail(envelope);
			if (detail) return detail;
		}
	} catch {
		return null;
	}
	return null;
}

function employmentRows(list: any[] | undefined, kind: 'current' | 'previous') {
	const rows: Array<Record<string, string | null>> = [];
	for (const entry of list || []) {
		if (!entry || typeof entry !== 'object') continue;
		const firmCrd = normalizeCrd(entry.firmId ?? entry.firm_id ?? entry.crd);
		rows.push({
			kind,
			firmCrd,
			firmName: entry.firmName || entry.firm_name || null,
			begin: entry.registrationBeginDate || entry.beginDate || entry.startDate || null,
			end: entry.registrationEndDate || entry.endDate || null,
			city: entry.city || null,
			state: entry.state || null,
		});
	}
	return rows;
}

export async function runLocalAiTool(
	name: string,
	args: Record<string, unknown> = {},
	context: { canvasSnapshot?: CanvasSnapshot | null } = {},
): Promise<{ ok: boolean; tool: string; result: unknown }> {
	const tool = String(name || '').trim() as LocalAiToolName;

	if (tool === 'inspect_canvas_graph') {
		const inspected = inspectCanvasSnapshot(context.canvasSnapshot, args);
		return { ok: inspected.ok, tool, result: inspected.result };
	}

	if (tool === 'firm_current_roster') {
		const firmCrd = normalizeCrd(args.firmCrd);
		if (!firmCrd) return { ok: false, tool, result: { error: 'firmCrd required' } };
		const limit = clampLimit(args.limit);
		const query = String(args.query || '')
			.trim()
			.toLowerCase();
		const people = loadFirmCurrentPeople(firmCrd);
		let rows = Array.from(people.entries()).map(([crd, name]) => ({
			line: formatPersonLine(name, crd),
			crd,
			name,
		}));
		if (query) {
			rows = rows.filter((r) => r.name.toLowerCase().includes(query) || r.crd.includes(query));
		}
		rows.sort((a, b) => a.name.localeCompare(b.name) || a.crd.localeCompare(b.crd));
		const sliced = rows.slice(0, limit);
		return {
			ok: true,
			tool,
			result: {
				firmCrd,
				totalCurrent: people.size,
				returned: sliced.length,
				people: sliced.map((r) => r.line),
			},
		};
	}

	if (tool === 'find_dual_current_people') {
		const minFirms = Math.max(2, clampLimit(args.minFirms, 2, 20));
		const limit = clampLimit(args.limit);
		const mustInclude = normalizeCrd(args.mustIncludeFirmCrd);
		const exclude = new Set(
			(Array.isArray(args.excludeFirmCrds) ? args.excludeFirmCrds : [])
				.map(normalizeCrd)
				.filter(Boolean) as string[],
		);
		const { personFirms, personNames } = buildPersonCurrentFirmIndex();
		const rows: Array<{ line: string; crd: string; firmCount: number; firms: string[] }> = [];
		for (const [crd, firms] of personFirms) {
			const counted = [...firms].filter((f) => !exclude.has(f));
			if (counted.length < minFirms) continue;
			if (mustInclude && !firms.has(mustInclude)) continue;
			rows.push({
				line: formatPersonLine(personNames.get(crd) || crd, crd),
				crd,
				firmCount: counted.length,
				firms: counted.sort(),
			});
		}
		rows.sort((a, b) => b.firmCount - a.firmCount || a.line.localeCompare(b.line));
		const sliced = rows.slice(0, limit);
		return {
			ok: true,
			tool,
			result: {
				minFirms,
				mustIncludeFirmCrd: mustInclude,
				totalMatches: rows.length,
				returned: sliced.length,
				people: sliced.map((r) => ({
					line: r.line,
					firmCount: r.firmCount,
					firmCrds: r.firms,
				})),
			},
		};
	}

	if (tool === 'people_bridging_firm_sets') {
		const setA = new Set(
			(Array.isArray(args.setAFirmCrds) ? args.setAFirmCrds : [])
				.map(normalizeCrd)
				.filter(Boolean) as string[],
		);
		const setB = new Set(
			(Array.isArray(args.setBFirmCrds) ? args.setBFirmCrds : [])
				.map(normalizeCrd)
				.filter(Boolean) as string[],
		);
		if (!setA.size) return { ok: false, tool, result: { error: 'setAFirmCrds required' } };
		const limit = clampLimit(args.limit);
		// When setB is given, scanning only A∪B firm rosters is enough.
		// When setB is omitted ("any outside A"), scan all firm-connection files.
		const index = buildPersonCurrentFirmIndex(
			setB.size ? { onlyFirmCrds: new Set<string>([...setA, ...setB]) } : undefined,
		);
		const rows: Array<{ line: string; inA: string[]; inB: string[] }> = [];
		for (const [crd, firms] of index.personFirms) {
			const inA = [...firms].filter((f) => setA.has(f));
			if (!inA.length) continue;
			const inB =
				setB.size ? [...firms].filter((f) => setB.has(f))
				:	[...firms].filter((f) => !setA.has(f));
			if (!inB.length) continue;
			rows.push({
				line: formatPersonLine(index.personNames.get(crd) || crd, crd),
				inA: inA.sort(),
				inB: inB.sort(),
			});
		}
		rows.sort((a, b) => a.line.localeCompare(b.line));
		const sliced = rows.slice(0, limit);
		return {
			ok: true,
			tool,
			result: {
				setA: [...setA],
				setB: setB.size ? [...setB] : 'ANY_OUTSIDE_SET_A',
				totalMatches: rows.length,
				returned: sliced.length,
				people: sliced,
			},
		};
	}

	if (tool === 'person_employment_timeline') {
		const personCrd = normalizeCrd(args.personCrd);
		if (!personCrd) return { ok: false, tool, result: { error: 'personCrd required' } };
		const detail = await loadIndividualDetail(personCrd);
		if (!detail) {
			return {
				ok: false,
				tool,
				result: {
					error: 'individual detail not in local Redis cache',
					personCrd,
					hint: 'Cron owns CRD hydration; local-ai does not fetch new individuals',
				},
			};
		}
		const bi = detail.basicInformation || {};
		const name =
			[bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(' ') ||
			detail.name ||
			personCrd;
		const current = [
			...employmentRows(detail.currentEmployments, 'current'),
			...employmentRows(detail.currentIAEmployments, 'current'),
		];
		const previous = [
			...employmentRows(detail.previousEmployments, 'previous'),
			...employmentRows(detail.previousIAEmployments, 'previous'),
		];
		return {
			ok: true,
			tool,
			result: {
				line: formatPersonLine(name, personCrd),
				personCrd,
				name,
				currentFirmCount: new Set(current.map((r) => r.firmCrd).filter(Boolean)).size,
				current,
				previous,
			},
		};
	}

	if (tool === 'fetch_url') {
		const fetched = await fetchUrlForLocalAi(args.url, args.maxChars);
		return { ok: fetched.ok, tool, result: fetched.result };
	}

	if (tool === 'people_crd_year_stats') {
		const fromYear = Number(args.fromYear);
		const toYear = Number(args.toYear);
		const stats = getPeopleCrdYearStats({
			fromYear: Number.isFinite(fromYear) ? fromYear : undefined,
			toYear: Number.isFinite(toYear) ? toYear : undefined,
			includeFirms: args.includeFirms === undefined ? undefined : Boolean(args.includeFirms),
		});
		return { ok: stats.ok, tool, result: stats.result };
	}

	return { ok: false, tool: name, result: { error: `unknown tool: ${name}` } };
}
