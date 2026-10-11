#!/usr/bin/env node
/**
 * Destructive: FLUSHDB both Upstash shards, then reseed from local Redis
 * with firm/individual routing (no dual-write).
 *
 *   npx tsx --env-file=.env.local .local/scripts/purge_and_reseed_shards.mjs
 *   npx tsx --env-file=.env.local .local/scripts/purge_and_reseed_shards.mjs --skip-flush
 *   npx tsx --env-file=.env.local .local/scripts/purge_and_reseed_shards.mjs --flush-only
 */
import fs from 'node:fs';
import path from 'node:path';
import Redis from 'ioredis';
import { Redis as UpstashRedis } from '@upstash/redis';
import { partitionKeysByShard, readShardEnvConfig, resolveRedisShard } from '../../src/lib/redisShard.ts';

const argv = process.argv.slice(2);
const SKIP_FLUSH = argv.includes('--skip-flush');
const FLUSH_ONLY = argv.includes('--flush-only');
const BATCH = Math.max(1, Number((argv.find((a) => a.startsWith('--batch=')) || '--batch=80').slice(8)) || 80);
const SLEEP_MS = Math.max(0, Number((argv.find((a) => a.startsWith('--sleep=')) || '--sleep=80').slice(8)) || 80);

const MATCHES = [
	'finra:individual:*',
	'sec:individual:*',
	'finra:firm:*',
	'sec:firm:*',
	'firm-connections:firm:*',
	'non-live-crds:*',
	'dashboard:cached-crd-count',
	'dashboard:new-crds-cache',
	'finra:selection-refresh:*',
];

const ZSET_KEYS = ['dashboard:highest-crds:individual', 'dashboard:highest-crds:firm'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (obj) => console.log(JSON.stringify(obj));

async function scanLocal(local, match) {
	const keys = [];
	let cursor = '0';
	do {
		const [next, batch] = await local.scan(cursor, 'MATCH', match, 'COUNT', 1000);
		cursor = next;
		keys.push(...batch);
	} while (cursor !== '0');
	return keys;
}

async function main() {
	const cfg = readShardEnvConfig(process.env);
	if (!cfg.individual || !cfg.firm) {
		log({ ok: false, error: 'missing individual or firm shard env' });
		process.exit(1);
	}

	const ind = new UpstashRedis({ url: cfg.individual.url, token: cfg.individual.token });
	const firm = new UpstashRedis({ url: cfg.firm.url, token: cfg.firm.token });
	const clients = { individual: ind, firm };

	const before = {
		individual: await ind.dbsize(),
		firm: await firm.dbsize(),
	};
	log({ phase: 'before', before, batch: BATCH, sleepMs: SLEEP_MS });

	if (!SKIP_FLUSH) {
		const flushInd = await ind.flushdb();
		const flushFirm = await firm.flushdb();
		const afterFlush = {
			individual: await ind.dbsize(),
			firm: await firm.dbsize(),
		};
		log({ phase: 'flushed', flushInd, flushFirm, afterFlush });
		if (afterFlush.individual !== 0 || afterFlush.firm !== 0) {
			log({ ok: false, error: 'flush did not empty both shards', afterFlush });
			process.exit(1);
		}
	}

	if (FLUSH_ONLY) {
		log({ ok: true, phase: 'flush-only-done' });
		return;
	}

	const local = new Redis('redis://127.0.0.1:6379', { maxRetriesPerRequest: 2 });
	try {
		const allKeys = new Set();
		for (const match of MATCHES) {
			const found = await scanLocal(local, match);
			log({ phase: 'scan', match, found: found.length });
			for (const k of found) allKeys.add(k);
		}
		const keys = [...allKeys];

		const stringKeys = [];
		for (let i = 0; i < keys.length; i += 300) {
			const chunk = keys.slice(i, i + 300);
			const pipe = local.pipeline();
			for (const k of chunk) pipe.type(k);
			const types = await pipe.exec();
			for (let j = 0; j < chunk.length; j++) {
				if (types[j][1] === 'string') stringKeys.push(chunk[j]);
			}
		}
		log({ phase: 'plan', totalKeys: keys.length, stringKeys: stringKeys.length });

		let pushed = 0;
		for (let i = 0; i < stringKeys.length; i += BATCH) {
			const batchKeys = stringKeys.slice(i, i + BATCH);
			const parts = partitionKeysByShard(batchKeys);
			for (const shard of /** @type {const} */ (['individual', 'firm'])) {
				const shardKeys = parts[shard];
				if (!shardKeys.length) continue;
				const values = await local.mget(...shardKeys);
				const msetObj = {};
				for (let j = 0; j < shardKeys.length; j++) {
					if (values[j] !== null && values[j] !== undefined) msetObj[shardKeys[j]] = values[j];
				}
				const n = Object.keys(msetObj).length;
				if (!n) continue;
				await clients[shard].mset(msetObj);
				pushed += n;
			}
			if (i === 0 || (i / BATCH) % 25 === 0 || i + BATCH >= stringKeys.length) {
				log({
					phase: 'pushed',
					pushed,
					of: stringKeys.length,
					pct: Math.round((1000 * Math.min(i + BATCH, stringKeys.length)) / stringKeys.length) / 10,
				});
			}
			await sleep(SLEEP_MS);
		}

		// ZSETs (highest-CRD indexes)
		let zadded = 0;
		for (const zkey of ZSET_KEYS) {
			const t = await local.type(zkey);
			if (t !== 'zset') continue;
			const members = await local.zrange(zkey, 0, -1, 'WITHSCORES');
			const shard = resolveRedisShard(zkey);
			const client = clients[shard];
			for (let i = 0; i < members.length; i += 2) {
				const member = String(members[i]);
				const score = Number(members[i + 1]);
				await client.zadd(zkey, { score, member });
				zadded += 1;
			}
			log({ phase: 'zadd', key: zkey, shard, members: members.length / 2 });
		}

		const after = {
			individual: await ind.dbsize(),
			firm: await firm.dbsize(),
		};

		// Spot checks
		const spot = {
			'finra:individual:1085996': resolveRedisShard('finra:individual:1085996'),
			'finra:firm:11068': resolveRedisShard('finra:firm:11068'),
			'firm-connections:firm:6363': resolveRedisShard('firm-connections:firm:6363'),
		};
		const spotResults = {};
		for (const [key, shard] of Object.entries(spot)) {
			const existsTarget = await clients[shard].exists(key);
			const other = shard === 'individual' ? 'firm' : 'individual';
			const existsOther = await clients[other].exists(key);
			spotResults[key] = { shard, existsTarget, existsOther };
		}

		const stamp = {
			ok: true,
			phase: 'done',
			pushed,
			zadded,
			after,
			spotResults,
			finishedAt: new Date().toISOString(),
		};
		log(stamp);

		const outDir = path.join(process.cwd(), '.local', 'tmp');
		fs.mkdirSync(outDir, { recursive: true });
		const stampPath = path.join(outDir, 'last_shard_reseed.json');
		fs.writeFileSync(stampPath, JSON.stringify(stamp, null, 2));
		log({ phase: 'stamp', path: stampPath });
	} finally {
		await local.quit().catch(() => {});
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
