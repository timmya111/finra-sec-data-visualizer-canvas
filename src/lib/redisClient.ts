import { Redis as UpstashRedis } from '@upstash/redis';
import IORedis from 'ioredis';
import { isRedisCacheOnly, markRedisUnusable, noteRedisError } from '@/lib/redisAvailability';
import {
	DEFAULT_REDIS_SHARD,
	extractRoutingKeys,
	partitionKeysByShard,
	readShardEnvConfig,
	resolveRedisShard,
	resolveShardForCommand,
	type RedisShard,
} from '@/lib/redisShard';

let localIoRedis: IORedis | null = null;
// Cache Upstash client instances to avoid recreating HTTP clients on every
// invocation which adds latency and extra resource usage.
const upstashClientCache = new Map<string, UpstashRedis>();

const READ_METHODS = new Set([
	'get',
	'mget',
	'scan',
	'zrange',
	'smembers',
	'hgetall',
	'exists',
	'dbsize',
	'type',
	'keys',
	'hget',
	'zrevrange',
	'zscore',
	'zrank',
	'lrange',
]);
const WRITE_METHODS = new Set([
	'set',
	'mset',
	'hset',
	'zadd',
	'sadd',
	'del',
	'incr',
	'incrby',
	'expire',
	'flushall',
	'flushdb',
	'lpush',
	'ltrim',
	'rpush',
]);

function emptyReadResult(method: string): unknown {
	if (method === 'scan') return ['0', []];
	if (method === 'mget' || method === 'zrange' || method === 'zrevrange' || method === 'smembers' || method === 'keys' || method === 'lrange')
		return [];
	if (method === 'exists' || method === 'dbsize') return 0;
	if (method === 'hgetall') return {};
	return null;
}

/** When cache-only, short-circuit Redis; on limit-class errors, flip cache-only. */
function wrapClientForCacheOnly(client: UpstashRedis): UpstashRedis {
	return new Proxy(client, {
		get(target, prop) {
			const val = (target as any)[prop];
			if (typeof val !== 'function') return val;
			const propStr = String(prop);
			return function (...args: any[]) {
				if (isRedisCacheOnly()) {
					if (WRITE_METHODS.has(propStr)) return Promise.resolve(undefined);
					if (READ_METHODS.has(propStr)) return Promise.resolve(emptyReadResult(propStr));
					return Promise.resolve(undefined);
				}
				try {
					const result = val.apply(target, args);
					if (result && typeof result.then === 'function') {
						return result.catch((err: any) => {
							noteRedisError(err, propStr);
							if (isRedisCacheOnly()) {
								if (WRITE_METHODS.has(propStr)) return undefined;
								if (READ_METHODS.has(propStr)) return emptyReadResult(propStr);
								return undefined;
							}
							throw err;
						});
					}
					return result;
				} catch (err) {
					noteRedisError(err, propStr);
					if (isRedisCacheOnly()) {
						if (WRITE_METHODS.has(propStr)) return Promise.resolve(undefined);
						if (READ_METHODS.has(propStr)) return Promise.resolve(emptyReadResult(propStr));
						return Promise.resolve(undefined);
					}
					throw err;
				}
			};
		},
	});
}

function decodeRedisResult(value: any): any {
	if (Buffer.isBuffer(value)) return value.toString('utf-8');
	if (Array.isArray(value)) return value.map(decodeRedisResult);
	return value;
}

async function executeLocalRequest(req: any): Promise<any> {
	if (!localIoRedis) {
		localIoRedis = new IORedis('redis://127.0.0.1:6379');
		// Enable LRU caching on local Redis so it behaves like a bounded cache instead of an unbound DB
		localIoRedis.config('SET', 'maxmemory', '512mb').catch(() => {});
		localIoRedis.config('SET', 'maxmemory-policy', 'allkeys-lru').catch(() => {});
		console.log('Other local applications can now connect to your shared local cache at redis://127.0.0.1:6379!');
	}

	let body = req.body || [];
	if (typeof body === 'string') {
		body = JSON.parse(body);
	}

	if (Array.isArray(body) && Array.isArray(body[0])) {
		// pipeline
		const pipeline = localIoRedis.pipeline();
		body.forEach((cmd: any) => {
			// @ts-ignore
			pipeline.sendCommand(new IORedis.Command(cmd[0], cmd.slice(1)));
		});
		const res = await pipeline.exec();
		return res?.map((r) => (r[0] ? { error: r[0].message } : { result: decodeRedisResult(r[1]) }));
	} else if (Array.isArray(body)) {
		try {
			const res = await localIoRedis.sendCommand(new IORedis.Command(body[0], body.slice(1)));
			return { result: decodeRedisResult(res) };
		} catch (e: any) {
			return { error: e.message };
		}
	} else {
		return { error: 'Invalid payload' };
	}
}

function getOrCreateUpstash(url: string, token: string): UpstashRedis {
	const cacheKey = `${url}:${token}`;
	const existing = upstashClientCache.get(cacheKey);
	if (existing) return existing;
	const client = new UpstashRedis({ url, token });
	upstashClientCache.set(cacheKey, client);
	return client;
}

function markShardUnusable(err: any, shard: RedisShard, dead: { individual: boolean; firm: boolean }) {
	const msg = String(err?.message || '').toLowerCase();
	const authDead =
		msg.includes('wrongpass') ||
		msg.includes('invalid or missing auth') ||
		msg.includes('unauthorized') ||
		msg.includes('forbidden') ||
		msg.includes('401') ||
		msg.includes('403');
	const quotaDead =
		msg.includes('max') ||
		msg.includes('limit') ||
		msg.includes('exceeded') ||
		msg.includes('daily') ||
		msg.includes('quota') ||
		msg.includes('too many requests') ||
		msg.includes('429');
	if (!authDead && !quotaDead) return;
	dead[shard] = true;
	console.warn(`[Redis shard] ${shard} DB marked offline (${authDead ? 'auth' : 'quota'})`);
	if (dead.individual && dead.firm) {
		markRedisUnusable(authDead ? 'both Upstash shard DBs auth-failed' : 'both Upstash shard DBs maxxed');
	}
}

async function splitMget(
	clients: { individual: UpstashRedis; firm: UpstashRedis },
	dead: { individual: boolean; firm: boolean },
	keys: string[],
): Promise<unknown[]> {
	const { individual, firm } = partitionKeysByShard(keys);
	const indIdx = new Map<string, number[]>();
	const firmIdx = new Map<string, number[]>();
	keys.forEach((key, i) => {
		const map = resolveRedisShard(key) === 'individual' ? indIdx : firmIdx;
		const list = map.get(key) || [];
		list.push(i);
		map.set(key, list);
	});

	const out: unknown[] = new Array(keys.length).fill(null);

	const run = async (shard: RedisShard, shardKeys: string[]) => {
		if (!shardKeys.length || dead[shard]) return;
		const unique = [...new Set(shardKeys)];
		try {
			const values = await (clients[shard] as any).mget(...unique);
			unique.forEach((key, i) => {
				const val = Array.isArray(values) ? values[i] : null;
				const positions = (shard === 'individual' ? indIdx : firmIdx).get(key) || [];
				for (const pos of positions) out[pos] = val;
			});
		} catch (err: any) {
			markShardUnusable(err, shard, dead);
			noteRedisError(err, 'mget');
		}
	};

	await Promise.all([run('individual', individual), run('firm', firm)]);
	return out;
}

async function splitMset(
	clients: { individual: UpstashRedis; firm: UpstashRedis },
	dead: { individual: boolean; firm: boolean },
	args: any[],
): Promise<unknown> {
	const first = args[0];
	let entries: Array<[string, unknown]> = [];
	if (first && typeof first === 'object' && !Array.isArray(first)) {
		entries = Object.entries(first as Record<string, unknown>);
	} else if (Array.isArray(first)) {
		for (let i = 0; i < first.length; i += 2) entries.push([String(first[i]), first[i + 1]]);
	} else {
		for (let i = 0; i < args.length; i += 2) entries.push([String(args[i]), args[i + 1]]);
	}

	const indObj: Record<string, unknown> = {};
	const firmObj: Record<string, unknown> = {};
	for (const [k, v] of entries) {
		if (resolveRedisShard(k) === 'individual') indObj[k] = v;
		else firmObj[k] = v;
	}

	const ops: Promise<unknown>[] = [];
	if (Object.keys(indObj).length && !dead.individual) {
		ops.push(
			(clients.individual as any)
				.mset(indObj)
				.catch((err: any) => {
					markShardUnusable(err, 'individual', dead);
					console.error('[Redis shard] mset individual error:', err?.message || err);
					return undefined;
				}),
		);
	}
	if (Object.keys(firmObj).length && !dead.firm) {
		ops.push(
			(clients.firm as any)
				.mset(firmObj)
				.catch((err: any) => {
					markShardUnusable(err, 'firm', dead);
					console.error('[Redis shard] mset firm error:', err?.message || err);
					return undefined;
				}),
		);
	}
	const results = await Promise.all(ops);
	return results.find((r) => r !== undefined);
}

async function splitDelOrExists(
	clients: { individual: UpstashRedis; firm: UpstashRedis },
	dead: { individual: boolean; firm: boolean },
	method: 'del' | 'exists',
	keys: string[],
): Promise<number> {
	const { individual, firm } = partitionKeysByShard(keys);
	let total = 0;
	const run = async (shard: RedisShard, shardKeys: string[]) => {
		if (!shardKeys.length || dead[shard]) return;
		try {
			const res = await (clients[shard] as any)[method](...shardKeys);
			total += Number(res) || 0;
		} catch (err: any) {
			markShardUnusable(err, shard, dead);
			noteRedisError(err, method);
		}
	};
	await Promise.all([run('individual', individual), run('firm', firm)]);
	return total;
}

/**
 * Prefix-routed proxy: individuals DB + firms DB, single-write, no mirror failover.
 */
function createShardProxy(individualClient: UpstashRedis, firmClient: UpstashRedis): UpstashRedis {
	const clients = { individual: individualClient, firm: firmClient };
	const dead = { individual: false, firm: false };

	const pick = (shard: RedisShard) => clients[shard];

	const shardProxy = new Proxy(firmClient, {
		get(target, prop) {
			const val = (target as any)[prop];
			if (typeof val !== 'function') return val;

			return function (...args: any[]) {
				const propStr = String(prop);

				if (propStr === 'dbsize') {
					return (async () => {
						if (isRedisCacheOnly() || (dead.individual && dead.firm)) return 0;
						const sizes = await Promise.all(
							(['individual', 'firm'] as RedisShard[]).map(async (shard) => {
								if (dead[shard]) return 0;
								try {
									return Number(await (clients[shard] as any).dbsize()) || 0;
								} catch (err: any) {
									markShardUnusable(err, shard, dead);
									return 0;
								}
							}),
						);
						return sizes[0] + sizes[1];
					})();
				}

				if (propStr === 'flushall' || propStr === 'flushdb') {
					return (async () => {
						if (isRedisCacheOnly()) return undefined;
						await Promise.all(
							(['individual', 'firm'] as RedisShard[]).map(async (shard) => {
								if (dead[shard]) return;
								try {
									await (clients[shard] as any)[propStr]();
								} catch (err: any) {
									markShardUnusable(err, shard, dead);
									console.error(`[Redis shard] ${propStr} ${shard} error:`, err?.message || err);
								}
							}),
						);
						return 'OK';
					})();
				}

				if (propStr === 'mget') {
					return (async () => {
						if (isRedisCacheOnly() || (dead.individual && dead.firm)) return emptyReadResult('mget');
						const keys = extractRoutingKeys('mget', args);
						return splitMget(clients, dead, keys);
					})();
				}

				if (propStr === 'mset') {
					return (async () => {
						if (isRedisCacheOnly()) return undefined;
						return splitMset(clients, dead, args);
					})();
				}

				if (propStr === 'del' || propStr === 'exists') {
					return (async () => {
						if (isRedisCacheOnly()) {
							return propStr === 'exists' ? 0 : undefined;
						}
						const keys = extractRoutingKeys(propStr, args);
						const parts = partitionKeysByShard(keys);
						if (parts.individual.length && parts.firm.length) {
							return splitDelOrExists(clients, dead, propStr as 'del' | 'exists', keys);
						}
						const shard = resolveShardForCommand(propStr, args);
						if (dead[shard]) return propStr === 'exists' ? 0 : 0;
						try {
							return await (pick(shard) as any)[propStr](...args);
						} catch (err: any) {
							markShardUnusable(err, shard, dead);
							noteRedisError(err, propStr);
							return propStr === 'exists' ? 0 : 0;
						}
					})();
				}

				if (READ_METHODS.has(propStr) || WRITE_METHODS.has(propStr)) {
					return (async () => {
						if (isRedisCacheOnly()) {
							if (WRITE_METHODS.has(propStr)) return undefined;
							return emptyReadResult(propStr);
						}
						const shard = resolveShardForCommand(propStr, args);
						if (dead[shard]) {
							return WRITE_METHODS.has(propStr) ? undefined : emptyReadResult(propStr);
						}
						try {
							return await (pick(shard) as any)[propStr](...args);
						} catch (err: any) {
							markShardUnusable(err, shard, dead);
							noteRedisError(err, propStr);
							if (WRITE_METHODS.has(propStr)) return undefined;
							return emptyReadResult(propStr);
						}
					})();
				}

				// pipeline / other: prefer firms DB (shared default)
				const shard = DEFAULT_REDIS_SHARD;
				return (pick(dead[shard] ? 'individual' : shard) as any)[propStr](...args);
			};
		},
	}) as UpstashRedis;

	return shardProxy;
}

export function getRedisClientInstance(config: { url: string; token: string }) {
	const isLocalhost = process.env.USE_LOCAL_REDIS === '1';

	if (isLocalhost) {
		return wrapClientForCacheOnly(
			new UpstashRedis({
				request: executeLocalRequest,
			} as any),
		);
	}

	const shards = readShardEnvConfig();
	const disableFirm =
		process.env.UPSTASH_REDIS_DISABLE_MIRROR === '1' ||
		process.env.UPSTASH_REDIS_DISABLE_2 === '1' ||
		process.env.UPSTASH_REDIS_DISABLE_FIRM === '1';

	if (shards.individual && shards.firm && !disableFirm) {
		const cacheKey = `shard:${shards.individual.url}:${shards.individual.token}:${shards.firm.url}:${shards.firm.token}:co`;
		const existing = upstashClientCache.get(cacheKey);
		if (existing) return existing;

		const individualClient = getOrCreateUpstash(shards.individual.url, shards.individual.token);
		const firmClient = getOrCreateUpstash(shards.firm.url, shards.firm.token);
		const wrapped = wrapClientForCacheOnly(createShardProxy(individualClient, firmClient));
		upstashClientCache.set(cacheKey, wrapped);
		return wrapped;
	}

	// Single-shard fallbacks
	if (shards.individual) {
		const cacheKey = `${shards.individual.url}:${shards.individual.token}:co`;
		const c =
			upstashClientCache.get(cacheKey) ??
			wrapClientForCacheOnly(getOrCreateUpstash(shards.individual.url, shards.individual.token));
		upstashClientCache.set(cacheKey, c);
		return c;
	}
	if (shards.firm) {
		const cacheKey = `${shards.firm.url}:${shards.firm.token}:co`;
		const c =
			upstashClientCache.get(cacheKey) ??
			wrapClientForCacheOnly(getOrCreateUpstash(shards.firm.url, shards.firm.token));
		upstashClientCache.set(cacheKey, c);
		return c;
	}

	const cfgKey = `${config.url}:${config.token}:co`;
	const c =
		upstashClientCache.get(cfgKey) ??
		wrapClientForCacheOnly(new UpstashRedis({ url: config.url, token: config.token }));
	upstashClientCache.set(cfgKey, c);
	return c;
}

/**
 * Read-only client with the same firm/individual shard routing. Writes reject.
 */
export function getReadOnlyRedisClientInstance(config?: { url?: string; token?: string }) {
	const isLocalhost = process.env.USE_LOCAL_REDIS === '1';
	if (isLocalhost) {
		return new UpstashRedis({ request: executeLocalRequest } as any);
	}

	const shards = readShardEnvConfig();
	const disableFirm =
		process.env.UPSTASH_REDIS_DISABLE_MIRROR === '1' ||
		process.env.UPSTASH_REDIS_DISABLE_2 === '1' ||
		process.env.UPSTASH_REDIS_DISABLE_FIRM === '1';

	const readMethods = new Set([
		'get',
		'mget',
		'scan',
		'zrange',
		'smembers',
		'hgetall',
		'exists',
		'dbsize',
		'type',
		'keys',
		'hget',
		'zrevrange',
		'zscore',
		'zrank',
		'zincrby',
		'lrange',
	]);

	if (shards.individual && shards.firm && !disableFirm) {
		const proxy = createShardProxy(
			getOrCreateUpstash(shards.individual.url, shards.individual.token),
			getOrCreateUpstash(shards.firm.url, shards.firm.token),
		);
		return new Proxy(proxy, {
			get(target, prop) {
				const val = (target as any)[prop];
				if (typeof val !== 'function') return val;
				return function (...args: any[]) {
					const propStr = String(prop);
					if (!readMethods.has(propStr)) {
						return Promise.reject(new Error('Redis client is read-only: write methods are not allowed'));
					}
					return (proxy as any)[propStr](...args);
				};
			},
		});
	}

	if (shards.individual) return getOrCreateUpstash(shards.individual.url, shards.individual.token);
	if (shards.firm) return getOrCreateUpstash(shards.firm.url, shards.firm.token);

	return new UpstashRedis({ url: config?.url || '', token: config?.token || '' });
}

/** Direct shard clients for migration scripts (no proxy). */
export function getShardRedisClients(): { individual: UpstashRedis | null; firm: UpstashRedis | null } {
	if (process.env.USE_LOCAL_REDIS === '1') {
		const local = new UpstashRedis({ request: executeLocalRequest } as any);
		return { individual: local, firm: local };
	}
	const shards = readShardEnvConfig();
	return {
		individual: shards.individual
			? getOrCreateUpstash(shards.individual.url, shards.individual.token)
			: null,
		firm: shards.firm ? getOrCreateUpstash(shards.firm.url, shards.firm.token) : null,
	};
}
