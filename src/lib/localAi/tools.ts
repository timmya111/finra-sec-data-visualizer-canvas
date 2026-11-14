import fs from 'fs';
import path from 'path';
import { decompressPayload, getRedisClient } from '@/lib/redisCache';
import { unwrapCachedIndividualDetail } from '@/lib/graphConnections';
import { inspectCanvasSnapshot, type CanvasSnapshot } from '@/lib/localAi/canvasSnapshot';

const FIRM_CONN_DIR = path.join(process.cwd(), 'data', 'firm-connections');

export type LocalAiToolName =
	| 'inspect_canvas_graph'
	| 'find_dual_current_people'
	| 'firm_current_roster'
	| 'person_employment_timeline'
	| 'people_bridging_firm_sets';

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
];

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

	return { ok: false, tool: name, result: { error: `unknown tool: ${name}` } };
}
