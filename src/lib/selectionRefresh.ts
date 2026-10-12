/**
 * Deferred selection freshness checks: compare Redis-cached FINRA/SEC payloads
 * against live external APIs and write updates back to Redis.
 */
import type { Redis } from '@upstash/redis';
import { makeRedisKey } from '@/lib/crd';
import { compressPayload, decompressPayload, getRedisClient, isEmptyHitsObj } from '@/lib/redisCache';
import { DEFAULT_HEADERS } from '@/lib/requestConstants';
import { canCallExternalApis } from '@/lib/externalApiGate';
import { isCrdInInventory, rememberInventoryEntitiesDurable } from '@/lib/crdInventorySidecar';

export const SELECTION_REFRESH_BACKOFF_UNTIL_KEY = 'finra:selection-refresh:backoffUntil';
export const SELECTION_REFRESH_BACKOFF_MS_KEY = 'finra:selection-refresh:backoffMs';
export const SELECTION_REFRESH_HAD_429_KEY = 'finra:selection-refresh:had429';

export const BACKOFF_MIN_MS = 7 * 60 * 1000;
export const BACKOFF_MAX_MS = 9 * 60 * 1000;
export const BACKOFF_FLOOR_MS = 3 * 60 * 1000;
export const BACKOFF_STEP_MS = 45 * 1000;
export const PER_NODE_COOLDOWN_SECONDS = 45 * 60;

const INDIVIDUAL_QUERY = 'hl=true&includePrevious=true&wt=json';
const FIRM_QUERY = 'hl=true&wt=json';

export type SelectionRefreshKind = 'individual' | 'firm';

export type SelectionRefreshResult = {
	ok: boolean;
	kind?: SelectionRefreshKind;
	id?: string;
	updated?: boolean;
	unchanged?: boolean;
	skipped?: 'backoff' | 'cooldown' | 'disabled' | 'invalid' | 'no-redis';
	rateLimited?: boolean;
	resumeAt?: number;
	backoffMs?: number;
	detail?: Record<string, unknown> | null;
	sources?: { finraUpdated?: boolean; secUpdated?: boolean };
	error?: string;
};

function checkedKey(kind: SelectionRefreshKind, id: string) {
	return `finra:selection-refresh:checked:${kind}:${id}`;
}

export function initialBackoffMs(random = Math.random) {
	const unit = Math.min(0.999999, Math.max(0, Number(random()) || 0));
	return BACKOFF_MIN_MS + Math.floor(unit * (BACKOFF_MAX_MS - BACKOFF_MIN_MS + 1));
}

/** After a successful check that followed a 429, shorten the learned pause toward the floor. */
export function decreaseBackoffMs(currentMs: number, stepMs = BACKOFF_STEP_MS, floorMs = BACKOFF_FLOOR_MS) {
	const current = Number(currentMs);
	const safe = Number.isFinite(current) && current > 0 ? current : initialBackoffMs();
	return Math.max(floorMs, safe - Math.max(1, stepMs));
}

/** On a new 429, nudge the learned pause back up toward the 7–9 minute band. */
export function increaseBackoffMs(currentMs: number, stepMs = BACKOFF_STEP_MS, maxMs = BACKOFF_MAX_MS) {
	const current = Number(currentMs);
	const safe = Number.isFinite(current) && current > 0 ? current : initialBackoffMs();
	return Math.min(maxMs, Math.max(BACKOFF_MIN_MS, safe + Math.max(1, stepMs)));
}

/** Stable compare baseline: drop obviously volatile fields then stringify. */
export function fingerprintPayload(value: unknown): string {
	if (value == null) return '';
	try {
		const normalized = normalizeForFingerprint(value);
		return JSON.stringify(normalized);
	} catch {
		try {
			return typeof value === 'string' ? value : JSON.stringify(value);
		} catch {
			return '';
		}
	}
}

function normalizeForFingerprint(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeForFingerprint);
	if (!value || typeof value !== 'object') return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		const lower = key.toLowerCase();
		if (
			lower === 'fetchedat' ||
			lower === 'lastcheckedat' ||
			lower === 'cachedat' ||
			lower === 'timestamp' ||
			lower === '_source' ||
			lower.endsWith('checkedat')
		) {
			continue;
		}
		out[key] = normalizeForFingerprint(child);
	}
	return out;
}

export function payloadsDiffer(redisPayload: unknown, livePayload: unknown): boolean {
	if (livePayload == null) return false;
	if (redisPayload == null) return true;
	return fingerprintPayload(redisPayload) !== fingerprintPayload(livePayload);
}

function decodeRedisValue(raw: unknown): unknown {
	if (raw == null) return null;
	try {
		const text =
			typeof raw === 'string' ? decompressPayload(raw)
			: typeof raw === 'object' ? JSON.stringify(raw)
			: String(raw);
		if (!text) return null;
		return JSON.parse(text);
	} catch {
		return typeof raw === 'object' ? raw : null;
	}
}

function externalUrl(source: 'finra' | 'sec', kind: SelectionRefreshKind, id: string) {
	if (source === 'finra' && kind === 'individual') {
		return `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(id)}?${INDIVIDUAL_QUERY}`;
	}
	if (source === 'finra' && kind === 'firm') {
		return `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(id)}?${FIRM_QUERY}`;
	}
	if (source === 'sec' && kind === 'individual') {
		return `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(id)}?${INDIVIDUAL_QUERY}`;
	}
	return `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(id)}?${FIRM_QUERY}`;
}

function fetchHeaders(source: 'finra' | 'sec') {
	return {
		...DEFAULT_HEADERS,
		Referer: source === 'finra' ? 'https://brokercheck.finra.org/' : 'https://adviserinfo.sec.gov/',
	};
}

async function fetchLivePayload(source: 'finra' | 'sec', kind: SelectionRefreshKind, id: string): Promise<{ payload: unknown; status: number }> {
	const url = externalUrl(source, kind, id);
	const res = await fetch(url, { headers: fetchHeaders(source), redirect: 'follow' });
	if (res.status === 429) {
		return { payload: null, status: 429 };
	}
	if (!res.ok) {
		return { payload: null, status: res.status };
	}
	const payload = await res.json().catch(() => null);
	return { payload, status: res.status };
}

function pickSourceDetail(payload: unknown, contentKey: string): Record<string, unknown> | null {
	if (!payload || typeof payload !== 'object') return null;
	const hits = (payload as any)?.hits?.hits;
	if (Array.isArray(hits) && hits[0]?._source) {
		const source = hits[0]._source;
		const raw = source?.[contentKey] ?? source?.content ?? source?.iacontent;
		if (typeof raw === 'string') {
			try {
				const parsed = JSON.parse(raw);
				return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
			} catch {
				return null;
			}
		}
		if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
		return source as Record<string, unknown>;
	}
	return payload as Record<string, unknown>;
}

function mergeUniqueEmploymentArrays(primary: unknown, secondary: unknown): unknown[] {
	const a = Array.isArray(primary) ? primary : [];
	const b = Array.isArray(secondary) ? secondary : [];
	if (!a.length) return b.slice();
	if (!b.length) return a.slice();
	const seen = new Set<string>();
	const out: unknown[] = [];
	for (const entry of [...a, ...b]) {
		const rec = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
		const firmId = String(rec?.firmId ?? rec?.firm_id ?? '').trim();
		const firmName = String(rec?.firmName ?? rec?.firm_name ?? '').trim().toLowerCase();
		const start = String(rec?.registrationBeginDate ?? rec?.startDate ?? rec?.start ?? '').trim();
		const end = String(rec?.registrationEndDate ?? rec?.endDate ?? rec?.end ?? '').trim();
		const key = `${firmId}|${firmName}|${start}|${end}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(entry);
	}
	return out;
}

/** Merge FINRA + SEC details without letting empty FINRA IA arrays wipe SEC history. */
export function extractDetail(kind: SelectionRefreshKind, finra: unknown, sec: unknown): Record<string, unknown> | null {
	const finraDetail = pickSourceDetail(finra, 'content');
	const secDetail = pickSourceDetail(sec, kind === 'individual' ? 'iacontent' : 'content');
	if (!finraDetail && !secDetail) return null;
	if (finraDetail && secDetail) {
		const merged: Record<string, unknown> = { ...secDetail, ...finraDetail };
		if (kind === 'individual') {
			merged.currentEmployments = mergeUniqueEmploymentArrays(finraDetail.currentEmployments, secDetail.currentEmployments);
			merged.previousEmployments = mergeUniqueEmploymentArrays(finraDetail.previousEmployments, secDetail.previousEmployments);
			// Prefer SEC IA arrays; keep FINRA IA rows if present.
			merged.currentIAEmployments = mergeUniqueEmploymentArrays(secDetail.currentIAEmployments, finraDetail.currentIAEmployments);
			merged.previousIAEmployments = mergeUniqueEmploymentArrays(secDetail.previousIAEmployments, finraDetail.previousIAEmployments);
			merged.disclosures = mergeUniqueEmploymentArrays(finraDetail.disclosures, secDetail.disclosures);
			merged.iaDisclosures = mergeUniqueEmploymentArrays(secDetail.iaDisclosures, finraDetail.iaDisclosures);
		}
		merged.hasFinraData = true;
		merged.hasSecData = true;
		return merged;
	}
	const only = (finraDetail || secDetail) as Record<string, unknown>;
	return {
		...only,
		hasFinraData: Boolean(finraDetail),
		hasSecData: Boolean(secDetail),
	};
}

async function writeRedisPayload(redis: Redis, key: string, payload: unknown) {
	if (payload == null || isEmptyHitsObj(payload)) return false;
	const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
	const compressed = compressPayload(raw);
	await redis.set(key, compressed);
	return true;
}

async function readBackoffState(redis: Redis) {
	const [untilRaw, msRaw, had429Raw] = await Promise.all([
		redis.get(SELECTION_REFRESH_BACKOFF_UNTIL_KEY).catch(() => null),
		redis.get(SELECTION_REFRESH_BACKOFF_MS_KEY).catch(() => null),
		redis.get(SELECTION_REFRESH_HAD_429_KEY).catch(() => null),
	]);
	const backoffUntil = Number(untilRaw || 0);
	const backoffMs = Number(msRaw || 0);
	return {
		backoffUntil: Number.isFinite(backoffUntil) ? backoffUntil : 0,
		backoffMs: Number.isFinite(backoffMs) && backoffMs > 0 ? backoffMs : initialBackoffMs(),
		had429: Boolean(had429Raw === true || had429Raw === '1' || had429Raw === 1),
	};
}

export async function runSelectionRefresh(
	kind: SelectionRefreshKind,
	rawId: string,
	options: { redis?: Redis | null; now?: number } = {},
): Promise<SelectionRefreshResult> {
	const id = String(rawId || '')
		.trim()
		.replace(/^(person|individual|firm)[:_]/i, '');
	if (!/^\d+$/.test(id) || (kind !== 'individual' && kind !== 'firm')) {
		return { ok: false, skipped: 'invalid', error: 'invalid kind/id' };
	}
	if (!canCallExternalApis()) {
		return { ok: true, skipped: 'disabled', kind, id };
	}

	const redis = options.redis === undefined ? getRedisClient() : options.redis;
	if (!redis) {
		return { ok: false, skipped: 'no-redis', kind, id, error: 'Missing Redis configuration' };
	}

	const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
	const backoff = await readBackoffState(redis);
	if (backoff.backoffUntil > now) {
		return {
			ok: true,
			skipped: 'backoff',
			kind,
			id,
			resumeAt: backoff.backoffUntil,
			backoffMs: backoff.backoffMs,
		};
	}

	const finraKey = makeRedisKey('finra', kind, id);
	const secKey = makeRedisKey('sec', kind, id);
	const [finraCachedRaw, secCachedRaw] = await Promise.all([redis.get(finraKey).catch(() => null), redis.get(secKey).catch(() => null)]);
	const finraCached = decodeRedisValue(finraCachedRaw);
	const secCached = decodeRedisValue(secCachedRaw);

	const cooldownKey = checkedKey(kind, id);
	try {
		const already = await redis.get(cooldownKey).catch(() => null);
		if (already) {
			// Still return Redis-merged detail so the sidebar can hydrate without another external hit.
			return {
				ok: true,
				skipped: 'cooldown',
				kind,
				id,
				unchanged: true,
				detail: extractDetail(kind, finraCached, secCached),
				sources: { finraUpdated: false, secUpdated: false },
			};
		}
	} catch {
		/* ignore */
	}

	let finraLive: unknown = null;
	let secLive: unknown = null;
	let finraStatus = 0;
	let secStatus = 0;

	try {
		const [finraRes, secRes] = await Promise.all([fetchLivePayload('finra', kind, id), fetchLivePayload('sec', kind, id)]);
		finraLive = finraRes.payload;
		secLive = secRes.payload;
		finraStatus = finraRes.status;
		secStatus = secRes.status;
	} catch (error: any) {
		const status = Number(error?.status || error?.response?.status || 0);
		if (status === 429) {
			finraStatus = 429;
		} else {
			return { ok: false, kind, id, error: String(error?.message || error) };
		}
	}

	if (finraStatus === 429 || secStatus === 429) {
		const nextMs = increaseBackoffMs(backoff.backoffMs);
		const resumeAt = now + nextMs;
		await Promise.all([
			redis.set(SELECTION_REFRESH_BACKOFF_MS_KEY, String(nextMs)).catch(() => null),
			redis.set(SELECTION_REFRESH_BACKOFF_UNTIL_KEY, String(resumeAt)).catch(() => null),
			redis.set(SELECTION_REFRESH_HAD_429_KEY, '1').catch(() => null),
		]);
		return { ok: true, kind, id, rateLimited: true, resumeAt, backoffMs: nextMs };
	}

	// Successful check after a prior 429 → shrink learned pause.
	if (backoff.had429) {
		const shrunk = decreaseBackoffMs(backoff.backoffMs);
		await Promise.all([
			redis.set(SELECTION_REFRESH_BACKOFF_MS_KEY, String(shrunk)).catch(() => null),
			redis.set(SELECTION_REFRESH_HAD_429_KEY, '0').catch(() => null),
			redis.del(SELECTION_REFRESH_BACKOFF_UNTIL_KEY).catch(() => null),
		]);
	}

	const finraUpdated = payloadsDiffer(finraCached, finraLive);
	const secUpdated = payloadsDiffer(secCached, secLive);
	let wrote = false;
	if (finraUpdated && finraLive) {
		wrote = (await writeRedisPayload(redis, finraKey, finraLive)) || wrote;
	}
	if (secUpdated && secLive) {
		wrote = (await writeRedisPayload(redis, secKey, secLive)) || wrote;
	}

	try {
		await redis.set(cooldownKey, '1', { ex: PER_NODE_COOLDOWN_SECONDS });
	} catch {
		/* ignore */
	}

	const detail = extractDetail(kind, finraLive || finraCached, secLive || secCached);
	const updated = Boolean(wrote && (finraUpdated || secUpdated));

	if (updated) {
		try {
			const membership = isCrdInInventory(id);
			const known = kind === 'firm' ? membership.isFirm : membership.isIndividual;
			if (!known) {
				await rememberInventoryEntitiesDurable([{ kind, id }], redis as any);
			}
		} catch {
			/* ignore */
		}
	}

	return {
		ok: true,
		kind,
		id,
		updated,
		unchanged: !updated,
		detail,
		sources: { finraUpdated, secUpdated },
	};
}
