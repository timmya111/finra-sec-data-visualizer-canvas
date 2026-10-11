#!/usr/bin/env node
/**
 * Quota-friendly delta push: local Redis → Upstash firm/individual shards via batched MSET.
 *
 * Shard map (no mirrors):
 *   individuals → UPSTASH_REDIS_REST_URL (or UPSTASH_REDIS_INDIVIDUAL_*)
 *   firms       → UPSTASH_REDIS_REST_URL_MIRROR (or UPSTASH_REDIS_FIRM_*)
 *
 * Prefer this over push_all_to_prod.mjs when only new/changed keys need syncing.
 *
 *   npx tsx --env-file=.env.local .local/scripts/push_delta_to_prod.mjs \
 *     --match='firm-connections:firm:*' --match='sec:firm:*' --match='sec:individual:*'
 *
 *   npx tsx --env-file=.env.local .local/scripts/push_delta_to_prod.mjs \
 *     --keys-file=.local/tmp/keys_to_push.txt --batch=50 --sleep=200
 *
 * Flags:
 *   --match=PATTERN     SCAN match (repeatable). Default: firm-connections:firm:*
 *   --keys-file=PATH    Explicit key list (one per line)
 *   --batch=N           MSET batch size (default 50)
 *   --sleep=MS          Delay between Upstash batches (default 150)
 *   --dry-run           List keys only
 *   --skip-exists       Skip keys that already exist on the target shard
 *   --db=both|individual|firm|1|2   Target (default both). 1=individual, 2=firm
 */
import fs from 'node:fs';
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

const BATCH = Math.max(1, Number(flag('batch', '50')) || 50);
const SLEEP_MS = Math.max(0, Number(flag('sleep', '150')) || 150);
const DRY = argv.includes('--dry-run');
const SKIP_EXISTS = argv.includes('--skip-exists');
const DB_RAW = flag('db', 'both');
const KEYS_FILE = flag('keys-file');
const MATCHES = flags('match');
const patterns = MATCHES.length ? MATCHES : ['firm-connections:firm:*'];

function normalizeDbTarget(raw) {
	const v = String(raw || 'both').toLowerCase();
	if (v === '1' || v === 'individual' || v === 'ind') return 'individual';
	if (v === '2' || v === 'firm' || v === 'firms') return 'firm';
	return 'both';
}
const DB = normalizeDbTarget(DB_RAW);

const local = new Redis('redis://127.0.0.1:6379', { maxRetriesPerRequest: 2 });
const shardEnv = readShardEnvConfig(process.env);
const dbIndividual =
	DB === 'firm' || !shardEnv.individual
		? null
		: new UpstashRedis({ url: shardEnv.individual.url, token: shardEnv.individual.token });
const dbFirm =
	DB === 'individual' || !shardEnv.firm
		? null
		: new UpstashRedis({ url: shardEnv.firm.url, token: shardEnv.firm.token });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scanLocal(match) {
	const keys = [];
	let cursor = '0';
	do {
		const [next, batch] = await local.scan(cursor, 'MATCH', match, 'COUNT', 500);
		cursor = next;
		keys.push(...batch);
	} while (cursor !== '0');
	return keys;
}

async function main() {
	let keys = [];
	if (KEYS_FILE) {
		keys = fs
			.readFileSync(KEYS_FILE, 'utf8')
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean);
	} else {
		for (const match of patterns) {
			const found = await scanLocal(match);
			console.log(JSON.stringify({ phase: 'scan', match, found: found.length }));
			keys.push(...found);
		}
		keys = [...new Set(keys)];
	}

	// Only string-capable keys (skip zsets/sets — sync those separately)
	const stringKeys = [];
	for (let i = 0; i < keys.length; i += 200) {
		const chunk = keys.slice(i, i + 200);
		const pipe = local.pipeline();
		for (const k of chunk) pipe.type(k);
		const types = await pipe.exec();
		for (let j = 0; j < chunk.length; j++) {
			if (types[j][1] === 'string') stringKeys.push(chunk[j]);
		}
	}

	console.log(
		JSON.stringify({
			phase: 'plan',
			mode: 'firm-individual-shard',
			total: keys.length,
			stringKeys: stringKeys.length,
			batch: BATCH,
			sleepMs: SLEEP_MS,
			dryRun: DRY,
			db: DB,
		}),
	);

	if (DRY) {
		for (const k of stringKeys.slice(0, 50)) console.log(`${resolveRedisShard(k)}\t${k}`);
		if (stringKeys.length > 50) console.log(`… +${stringKeys.length - 50} more`);
		await local.quit();
		return;
	}

	let pushed = 0;
	let skipped = 0;
	for (let i = 0; i < stringKeys.length; i += BATCH) {
		const batchKeys = stringKeys.slice(i, i + BATCH);
		const parts = partitionKeysByShard(batchKeys);
		const shardBatches = [
			{ shard: 'individual', keys: parts.individual, client: dbIndividual },
			{ shard: 'firm', keys: parts.firm, client: dbFirm },
		];

		for (const { shard, keys: shardKeys, client } of shardBatches) {
			if (!shardKeys.length || !client) continue;

			let toPush = shardKeys;
			if (SKIP_EXISTS) {
				const remote = await client.mget(...shardKeys);
				toPush = [];
				for (let j = 0; j < shardKeys.length; j++) {
					if (remote[j] === null || remote[j] === undefined) toPush.push(shardKeys[j]);
					else skipped += 1;
				}
				if (!toPush.length) {
					console.log(JSON.stringify({ phase: 'skip-batch', shard, i, skipped, checked: shardKeys.length }));
					continue;
				}
			}

			const values = await local.mget(...toPush);
			const msetObj = {};
			for (let j = 0; j < toPush.length; j++) {
				if (values[j] !== null && values[j] !== undefined) msetObj[toPush[j]] = values[j];
			}
			const n = Object.keys(msetObj).length;
			if (!n) continue;

			await client.mset(msetObj);
			pushed += n;
			console.log(
				JSON.stringify({
					phase: 'pushed',
					shard,
					batch: n,
					pushed,
					sampleShard: resolveRedisShard(Object.keys(msetObj)[0]),
					remaining: Math.max(0, stringKeys.length - i - BATCH),
				}),
			);
		}
		await sleep(SLEEP_MS);
	}

	console.log(
		JSON.stringify({
			ok: true,
			phase: 'done',
			mode: 'firm-individual-shard',
			pushed,
			skipped,
			stringKeys: stringKeys.length,
		}),
	);
	await local.quit();
}

main().catch(async (e) => {
	console.error(e);
	try {
		await local.quit();
	} catch {}
	process.exit(1);
});
