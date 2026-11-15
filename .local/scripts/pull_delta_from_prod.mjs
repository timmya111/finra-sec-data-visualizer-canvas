#!/usr/bin/env node
/**
 * Incremental pull: Upstash prod shards → local Redis only.
 *
 * Prod cron owns hydration; local Redis should catch up on each localhost start.
 * This script NEVER writes to Upstash (read cloud, write 127.0.0.1:6379 only).
 *
 *   npx tsx --env-file=.env.local .local/scripts/pull_delta_from_prod.mjs
 *   npx tsx --env-file=.env.local .local/scripts/pull_delta_from_prod.mjs --limit=3000
 *   npx tsx --env-file=.env.local .local/scripts/pull_delta_from_prod.mjs --crd=6324385,8113907
 *   npx tsx --env-file=.env.local .local/scripts/pull_delta_from_prod.mjs --keys-file=/tmp/keys.txt
 *   npx tsx --env-file=.env.local .local/scripts/pull_delta_from_prod.mjs --overwrite --dry-run
 *
 * Flags:
 *   --match=PATTERN   SCAN match on the owning Upstash shard (repeatable).
 *                     Default: finra:individual:* sec:individual:* finra:firm:* sec:firm:* firm-connections:firm:*
 *   --crd=A,B         Explicit individual CRDs → finra:/sec:individual:<crd>
 *   --firm-crd=A,B    Explicit firm CRDs → finra:/sec:firm:<crd> + firm-connections:firm:<crd>
 *   --keys-file=PATH  Explicit key list (one per line)
 *   --limit=N         Max cloud keys to consider this run (default 2500). Cursor resumes next run.
 *   --batch=N         MGET/MSET batch size (default 50)
 *   --sleep=MS        Delay between Upstash batches (default 50)
 *   --overwrite       Refresh local when cloud value differs (default: missing-only SET NX)
 *   --reset-cursor    Clear saved SCAN cursors before pulling
 *   --dry-run         Plan only
 *   --quiet           Less progress logging (for start-local-redis background)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { Redis as UpstashRedis } from '@upstash/redis';
import { partitionKeysByShard, readShardEnvConfig, resolveRedisShard } from '../../src/lib/redisShard.ts';

const argv = process.argv.slice(2);
function flag(name, fallback = '') {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(`--${name}=`.length) : fallback;
}
function flags(name) {
	return argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(`--${name}=`.length));
}
function csv(name) {
	const raw = flag(name, '');
	return raw
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

const BATCH = Math.max(1, Number(flag('batch', '50')) || 50);
const SLEEP_MS = Math.max(0, Number(flag('sleep', '50')) || 50);
const LIMIT = Math.max(1, Number(flag('limit', '2500')) || 2500);
const DRY = argv.includes('--dry-run');
const OVERWRITE = argv.includes('--overwrite');
const RESET_CURSOR = argv.includes('--reset-cursor');
const QUIET = argv.includes('--quiet');
const KEYS_FILE = flag('keys-file');
const MATCHES = flags('match');
const CRDS = csv('crd');
const FIRM_CRDS = csv('firm-crd');

const DEFAULT_MATCHES = [
	'finra:individual:*',
	'sec:individual:*',
	'finra:firm:*',
	'sec:firm:*',
	'firm-connections:firm:*',
	'non-live-crds:individual:*',
	'non-live-crds:firm:*',
];
const patterns = MATCHES.length ? MATCHES : DEFAULT_MATCHES;

const CURSOR_KEY_PREFIX = 'local:pull-from-prod:v1:cursor:';
const STATE_KEY = 'local:pull-from-prod:v1:last-run';

const local = new Redis('redis://127.0.0.1:6379', { maxRetriesPerRequest: 2, lazyConnect: true });
const shardEnv = readShardEnvConfig(process.env);
const dbIndividual =
	shardEnv.individual ?
		new UpstashRedis({
			url: shardEnv.individual.url,
			token: shardEnv.individual.token,
			automaticDeserialization: false,
		})
	:	null;
const dbFirm =
	shardEnv.firm ?
		new UpstashRedis({
			url: shardEnv.firm.url,
			token: shardEnv.firm.token,
			automaticDeserialization: false,
		})
	:	null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => {
	if (!QUIET) console.log(...args);
};

function cursorKeyFor(match) {
	const digest = crypto.createHash('sha1').update(match).digest('hex').slice(0, 12);
	return `${CURSOR_KEY_PREFIX}${resolveRedisShard(match)}:${digest}`;
}

function cloudClientForShard(shard) {
	return shard === 'individual' ? dbIndividual : dbFirm;
}

function expandExplicitKeys() {
	const keys = [];
	for (const crd of CRDS) {
		if (!/^\d{1,10}$/.test(crd)) continue;
		keys.push(`finra:individual:${crd}`, `sec:individual:${crd}`, `non-live-crds:individual:${crd}`);
	}
	for (const crd of FIRM_CRDS) {
		if (!/^\d{1,10}$/.test(crd)) continue;
		keys.push(
			`finra:firm:${crd}`,
			`sec:firm:${crd}`,
			`firm-connections:firm:${crd}`,
			`non-live-crds:firm:${crd}`,
		);
	}
	if (KEYS_FILE) {
		const abs = path.resolve(KEYS_FILE);
		const lines = fs
			.readFileSync(abs, 'utf8')
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean);
		keys.push(...lines);
	}
	return [...new Set(keys)];
}

async function scanCloud(match, limit, startCursor = '0') {
	const shard = resolveRedisShard(match);
	const client = cloudClientForShard(shard);
	if (!client) throw new Error(`No Upstash credentials for shard=${shard} (match=${match})`);

	const collected = [];
	let cursor = String(startCursor || '0');
	let pages = 0;
	do {
		const [nextCursor, batch] = await client.scan(cursor, { match, count: 500 });
		cursor = String(nextCursor);
		pages += 1;
		for (const key of batch || []) {
			collected.push(String(key));
			if (collected.length >= limit) {
				return { keys: collected, cursor, done: false, pages, shard };
			}
		}
	} while (cursor !== '0');
	return { keys: collected, cursor: '0', done: true, pages, shard };
}

function valuesEqual(a, b) {
	if (a == null && b == null) return true;
	if (a == null || b == null) return false;
	if (typeof a === 'string' && typeof b === 'string') return a === b;
	return JSON.stringify(a) === JSON.stringify(b);
}

async function pullKeys(keys) {
	let pulled = 0;
	let skipped = 0;
	let refreshed = 0;
	let missingOnCloud = 0;

	for (let i = 0; i < keys.length; i += BATCH) {
		const batchKeys = keys.slice(i, i + BATCH);
		const parts = partitionKeysByShard(batchKeys);
		const shardBatches = [
			{ shard: 'individual', keys: parts.individual, client: dbIndividual },
			{ shard: 'firm', keys: parts.firm, client: dbFirm },
		];

		for (const { shard, keys: shardKeys, client } of shardBatches) {
			if (!shardKeys.length) continue;
			if (!client) {
				log(JSON.stringify({ phase: 'skip-no-cloud', shard, count: shardKeys.length }));
				continue;
			}

			const localPipe = local.pipeline();
			for (const k of shardKeys) localPipe.exists(k);
			if (OVERWRITE) {
				for (const k of shardKeys) localPipe.get(k);
			}
			const localRes = await localPipe.exec();
			const existsFlags = localRes.slice(0, shardKeys.length).map((row) => Number(row?.[1] || 0) > 0);
			const localValues =
				OVERWRITE ? localRes.slice(shardKeys.length).map((row) => row?.[1] ?? null) : shardKeys.map(() => null);

			const needFetch = [];
			for (let j = 0; j < shardKeys.length; j++) {
				if (!existsFlags[j]) needFetch.push({ key: shardKeys[j], mode: 'missing', idx: j });
				else if (OVERWRITE) needFetch.push({ key: shardKeys[j], mode: 'compare', idx: j, localValue: localValues[j] });
				else skipped += 1;
			}
			if (!needFetch.length) continue;

			const remote = await client.mget(...needFetch.map((e) => e.key));
			const toSet = [];
			for (let j = 0; j < needFetch.length; j++) {
				const entry = needFetch[j];
				const cloudVal = remote[j];
				if (cloudVal === null || cloudVal === undefined) {
					missingOnCloud += 1;
					continue;
				}
				if (entry.mode === 'compare' && valuesEqual(entry.localValue, cloudVal)) {
					skipped += 1;
					continue;
				}
				toSet.push({
					key: entry.key,
					value: typeof cloudVal === 'string' ? cloudVal : JSON.stringify(cloudVal),
					mode: entry.mode,
				});
			}

			if (!toSet.length) continue;
			if (DRY) {
				for (const row of toSet) {
					pulled += row.mode === 'missing' ? 1 : 0;
					refreshed += row.mode === 'compare' ? 1 : 0;
				}
				log(
					JSON.stringify({
						phase: 'dry-batch',
						shard,
						wouldWrite: toSet.length,
						sample: toSet.slice(0, 3).map((r) => r.key),
					}),
				);
				continue;
			}

			const writePipe = local.pipeline();
			for (const row of toSet) {
				if (row.mode === 'missing' && !OVERWRITE) writePipe.set(row.key, row.value, 'NX');
				else writePipe.set(row.key, row.value);
			}
			const writeRes = await writePipe.exec();
			for (let j = 0; j < toSet.length; j++) {
				const row = toSet[j];
				const ok = writeRes[j]?.[1];
				if (row.mode === 'missing') {
					if (ok === 'OK' || ok === true || OVERWRITE) pulled += 1;
					else skipped += 1;
				} else {
					refreshed += 1;
				}
			}
			log(
				JSON.stringify({
					phase: 'pulled-batch',
					shard,
					wrote: toSet.length,
					pulled,
					refreshed,
					skipped,
					remaining: Math.max(0, keys.length - i - BATCH),
				}),
			);
		}
		await sleep(SLEEP_MS);
	}

	return { pulled, skipped, refreshed, missingOnCloud };
}

async function main() {
	if (!dbIndividual && !dbFirm) {
		console.error('Missing Upstash shard credentials in env (.env.local UPSTASH_REDIS_*).');
		process.exit(2);
	}

	await local.connect();
	await local.ping();

	if (RESET_CURSOR) {
		const stale = [];
		let c = '0';
		do {
			const [next, batch] = await local.scan(c, 'MATCH', `${CURSOR_KEY_PREFIX}*`, 'COUNT', 100);
			c = next;
			stale.push(...batch);
		} while (c !== '0');
		if (stale.length) await local.del(...stale);
		log(JSON.stringify({ phase: 'reset-cursor', deleted: stale.length }));
	}

	const explicit = expandExplicitKeys();
	let plannedKeys = [];
	const scanMeta = [];

	if (explicit.length) {
		plannedKeys = explicit;
		log(JSON.stringify({ phase: 'explicit-keys', count: explicit.length }));
	} else {
		let remaining = LIMIT;
		for (const match of patterns) {
			if (remaining <= 0) break;
			const ck = cursorKeyFor(match);
			const startCursor = (await local.get(ck)) || '0';
			const scanned = await scanCloud(match, remaining, startCursor);
			plannedKeys.push(...scanned.keys);
			remaining = Math.max(0, LIMIT - plannedKeys.length);
			scanMeta.push({
				match,
				shard: scanned.shard,
				keys: scanned.keys.length,
				cursor: scanned.cursor,
				done: scanned.done,
				pages: scanned.pages,
				resumedFrom: startCursor,
			});
			if (!DRY) {
				await local.set(
					ck,
					scanned.cursor,
					'EX',
					60 * 60 * 24 * 30, // keep resume state ~30d
				);
			}
		}
		plannedKeys = [...new Set(plannedKeys)];
		log(JSON.stringify({ phase: 'scan', limit: LIMIT, planned: plannedKeys.length, scans: scanMeta }));
	}

	const stats = await pullKeys(plannedKeys);
	const summary = {
		ok: true,
		phase: 'done',
		direction: 'upstash→local',
		dryRun: DRY,
		overwrite: OVERWRITE,
		planned: plannedKeys.length,
		...stats,
		scans: scanMeta.length ? scanMeta : undefined,
	};
	console.log(JSON.stringify(summary));

	if (!DRY) {
		await local.set(STATE_KEY, JSON.stringify({ ...summary, at: new Date().toISOString() }));
	}
	await local.quit();
}

main().catch(async (err) => {
	console.error(err);
	try {
		await local.quit();
	} catch {
		/* ignore */
	}
	process.exit(1);
});
