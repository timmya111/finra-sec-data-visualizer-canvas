/**
 * Firm / individual Redis shard routing.
 *
 * Cloud layout (no mirrors, no dual-write):
 * - individuals DB: person detail + individual inventory / checked keys
 * - firms DB: firm detail, firm-connections, shared control keys
 *
 * Localhost (`USE_LOCAL_REDIS=1`) stays a single Redis and ignores sharding.
 */

export type RedisShard = 'individual' | 'firm';

/** Shared / unknown keys live on the firms DB. */
export const DEFAULT_REDIS_SHARD: RedisShard = 'firm';

/**
 * Resolve which Upstash DB owns a Redis key or SCAN match pattern.
 * FINRA + SEC for the same entity type stay on the same shard.
 */
export function resolveRedisShard(keyOrPattern: string | null | undefined): RedisShard {
	const key = String(keyOrPattern || '').trim();
	if (!key) return DEFAULT_REDIS_SHARD;

	// Explicit individual namespaces
	if (
		key.includes(':individual:') ||
		key.startsWith('finra:individual') ||
		key.startsWith('sec:individual') ||
		key.startsWith('non-live-crds:individual') ||
		key.startsWith('dashboard:highest-crds:individual') ||
		key.startsWith('finra:selection-refresh:checked:individual:')
	) {
		return 'individual';
	}

	// Explicit firm namespaces (including broker-id roster mirrors)
	if (
		key.includes(':firm:') ||
		key.startsWith('finra:firm') ||
		key.startsWith('sec:firm') ||
		key.startsWith('firm-connections:') ||
		key.startsWith('non-live-crds:firm') ||
		key.startsWith('dashboard:highest-crds:firm') ||
		key.startsWith('finra:selection-refresh:checked:firm:') ||
		/_brokers:(current|previous)\b/.test(key)
	) {
		return 'firm';
	}

	// Shared control / cron / dashboard aggregates → firms DB
	return DEFAULT_REDIS_SHARD;
}

export function partitionKeysByShard(keys: string[]): { individual: string[]; firm: string[] } {
	const individual: string[] = [];
	const firm: string[] = [];
	for (const key of keys) {
		if (resolveRedisShard(key) === 'individual') individual.push(key);
		else firm.push(key);
	}
	return { individual, firm };
}

/** First string arg that looks like a key, or SCAN `match` option. */
export function extractRoutingKeys(method: string, args: unknown[]): string[] {
	const m = String(method || '').toLowerCase();

	if (m === 'mget') {
		if (args.length === 1 && Array.isArray(args[0])) {
			return (args[0] as unknown[]).map((k) => String(k));
		}
		return args.map((k) => String(k));
	}

	if (m === 'mset') {
		const first = args[0];
		if (first && typeof first === 'object' && !Array.isArray(first)) {
			return Object.keys(first as Record<string, unknown>);
		}
		if (Array.isArray(first)) {
			const keys: string[] = [];
			for (let i = 0; i < first.length; i += 2) keys.push(String(first[i]));
			return keys;
		}
		// mset(k1, v1, k2, v2, ...)
		const keys: string[] = [];
		for (let i = 0; i < args.length; i += 2) keys.push(String(args[i]));
		return keys;
	}

	if (m === 'del' || m === 'exists' || m === 'unlink') {
		if (args.length === 1 && Array.isArray(args[0])) {
			return (args[0] as unknown[]).map((k) => String(k));
		}
		return args.map((k) => String(k));
	}

	if (m === 'scan') {
		const opts = args[1] as { match?: string } | undefined;
		if (opts && typeof opts.match === 'string' && opts.match) return [opts.match];
		// Unscoped SCAN spans both shards; caller handles composite cursor.
		return ['*'];
	}

	if (args.length > 0 && (typeof args[0] === 'string' || typeof args[0] === 'number')) {
		return [String(args[0])];
	}
	return [];
}

export function resolveShardForCommand(method: string, args: unknown[]): RedisShard {
	const keys = extractRoutingKeys(method, args);
	if (keys.length === 0) return DEFAULT_REDIS_SHARD;
	const shards = new Set(keys.map(resolveRedisShard));
	if (shards.size === 1) return shards.has('individual') ? 'individual' : 'firm';
	// Mixed multi-key commands are split by the client proxy; default only for odd cases.
	return DEFAULT_REDIS_SHARD;
}

export type ShardEnvConfig = {
	individual: { url: string; token: string } | null;
	firm: { url: string; token: string } | null;
};

/**
 * Individuals → UPSTASH_REDIS_REST_URL (or *_INDIVIDUAL_*).
 * Firms → UPSTASH_REDIS_REST_URL_MIRROR (or *_FIRM_*).
 */
export function readShardEnvConfig(env: NodeJS.ProcessEnv = process.env): ShardEnvConfig {
	const indUrl = env.UPSTASH_REDIS_INDIVIDUAL_URL || env.UPSTASH_REDIS_REST_URL || '';
	const indToken = env.UPSTASH_REDIS_INDIVIDUAL_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '';
	const firmUrl =
		env.UPSTASH_REDIS_FIRM_URL ||
		env.UPSTASH_REDIS_REST_URL_MIRROR ||
		env.UPSTASH_REDIS_REST_URL_2 ||
		'';
	const firmToken =
		env.UPSTASH_REDIS_FIRM_TOKEN ||
		env.UPSTASH_REDIS_REST_TOKEN_MIRROR ||
		env.UPSTASH_REDIS_REST_TOKEN_2 ||
		env.UPSTASH_REDIS_REST_TOKEN__2 ||
		'';

	return {
		individual: indUrl && indToken ? { url: indUrl, token: indToken } : null,
		firm: firmUrl && firmToken ? { url: firmUrl, token: firmToken } : null,
	};
}
