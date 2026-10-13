#!/usr/bin/env node
/**
 * Local rebuild + publish path for search sidecars.
 *
 * Vercel disk is read-only at runtime, so sidecars ship in git/deploy:
 *   1) merge Redis/disk into data/national/search-index.*.json(.gz)
 *   2) copy/chunk into public/search-indexes/
 *   3) commit + deploy when ready
 *
 * Usage:
 *   node .local/scripts/rebuild_search_sidecars.mjs --status
 *   NODE_OPTIONS=--max-old-space-size=8192 node .local/scripts/rebuild_search_sidecars.mjs --apply
 *   … --apply --build-only
 *   … --apply --copy-only
 *   … --apply --no-local-redis
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const NATIONAL_DIR = path.join(ROOT, 'data', 'national');
const PUBLIC_DIR = path.join(ROOT, 'public', 'search-indexes');
const TMP_DIR = path.join(ROOT, '.local', 'tmp');
const REPORT_PATH = path.join(TMP_DIR, 'search_sidecar_rebuild_report.json');

const BUCKET_FILES = [
	'search-index.finra.individual.json.gz',
	'search-index.finra.firm.json.gz',
	'search-index.sec.individual.json.gz',
	'search-index.sec.firm.json.gz',
];

function parseArgs(argv) {
	const flags = new Set();
	for (const arg of argv) {
		if (arg.startsWith('--')) flags.add(arg.slice(2));
	}
	return {
		status: flags.has('status') || flags.has('help') || flags.has('h'),
		apply: flags.has('apply'),
		buildOnly: flags.has('build-only'),
		copyOnly: flags.has('copy-only'),
		noLocalRedis: flags.has('no-local-redis'),
		help: flags.has('help') || flags.has('h'),
	};
}

function formatBytes(n) {
	const bytes = Number(n) || 0;
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileInfo(filePath) {
	try {
		const st = fs.statSync(filePath);
		return {
			exists: true,
			path: path.relative(ROOT, filePath),
			bytes: st.size,
			mtime: st.mtime.toISOString(),
			ageDays: Number(((Date.now() - st.mtimeMs) / (24 * 60 * 60 * 1000)).toFixed(2)),
		};
	} catch {
		return { exists: false, path: path.relative(ROOT, filePath), bytes: 0, mtime: null, ageDays: null };
	}
}

async function readRedisHighWater() {
	try {
		const { default: Redis } = await import('ioredis');
		const redis = new Redis('redis://127.0.0.1:6379', {
			maxRetriesPerRequest: 1,
			connectTimeout: 2000,
			lazyConnect: true,
			retryStrategy: () => null,
		});
		redis.on('error', () => {});
		try {
			await redis.connect();
			const [ind, firm] = await Promise.all([
				redis.zrevrange('dashboard:highest-crds:individual', 0, 0),
				redis.zrevrange('dashboard:highest-crds:firm', 0, 0),
			]);
			return {
				ok: true,
				individual: Number(ind?.[0]) || 0,
				firm: Number(firm?.[0]) || 0,
			};
		} finally {
			redis.disconnect();
		}
	} catch (error) {
		return { ok: false, individual: 0, firm: 0, error: String(error?.message || error) };
	}
}

function collectStatus(redisHighWater = null) {
	const buckets = BUCKET_FILES.map((name) => ({
		name,
		national: fileInfo(path.join(NATIONAL_DIR, name)),
		public: fileInfo(path.join(PUBLIC_DIR, name)),
		nationalJson: fileInfo(path.join(NATIONAL_DIR, name.replace(/\.gz$/, ''))),
	}));
	const ageStale =
		buckets.some((b) => !b.public.exists) ||
		buckets.some((b) => (b.public.ageDays ?? 0) > 7) ||
		buckets.some((b) => b.national.exists && b.public.exists && b.national.mtime > b.public.mtime);
	// Redis discoveries after the last sidecar copy usually need a rebuild even when age < 7d.
	const redisAheadHint = Boolean(redisHighWater?.ok && ((redisHighWater.individual || 0) > 0 || (redisHighWater.firm || 0) > 0));
	const stale = ageStale || (redisAheadHint && buckets.some((b) => (b.public.ageDays ?? 0) > 1));
	return {
		generatedAt: new Date().toISOString(),
		stale,
		ageStale,
		redisHighWater,
		useLocalRedisDefault: true,
		buckets,
		commands: {
			status: 'pnpm run sidecars:status',
			rebuild: 'pnpm run sidecars:rebuild',
			rebuildNoRedis: 'pnpm run sidecars:rebuild -- --no-local-redis',
		},
	};
}

function printStatus(status) {
	console.log(`Search sidecar status @ ${status.generatedAt}`);
	console.log(
		`stale hint: ${status.stale ? 'YES (missing, >7d, national newer than public, or Redis high-water with sidecars >1d old)' : 'no'}`,
	);
	if (status.redisHighWater?.ok) {
		console.log(`local Redis high-water: individual ${status.redisHighWater.individual} / firm ${status.redisHighWater.firm}`);
	} else if (status.redisHighWater?.error) {
		console.log(`local Redis high-water: unavailable (${status.redisHighWater.error})`);
	}
	console.log('');
	for (const bucket of status.buckets) {
		const nat = bucket.national.exists
			? `${formatBytes(bucket.national.bytes)}  mtime ${bucket.national.mtime}  (${bucket.national.ageDays}d)`
			: 'MISSING';
		const pub = bucket.public.exists
			? `${formatBytes(bucket.public.bytes)}  mtime ${bucket.public.mtime}  (${bucket.public.ageDays}d)`
			: 'MISSING';
		console.log(bucket.name);
		console.log(`  national: ${nat}`);
		console.log(`  public:   ${pub}`);
	}
	console.log('');
	console.log('Rebuild (local Redis + copy to public):');
	console.log(`  ${status.commands.rebuild}`);
	console.log('Then commit public/search-indexes/* (data/national is gitignored) and deploy.');
}

function runNodeScript(scriptRel, env = {}) {
	return new Promise((resolve, reject) => {
		const scriptPath = path.join(ROOT, scriptRel);
		const child = spawn(process.execPath, [scriptPath], {
			cwd: ROOT,
			env: { ...process.env, ...env },
			stdio: 'inherit',
		});
		child.on('error', reject);
		child.on('exit', (code, signal) => {
			if (signal) reject(new Error(`${scriptRel} exited from signal ${signal}`));
			else if (code) reject(new Error(`${scriptRel} exited with code ${code}`));
			else resolve();
		});
	});
}

function writeReport(report) {
	fs.mkdirSync(TMP_DIR, { recursive: true });
	fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
	console.log(`\nWrote ${path.relative(ROOT, REPORT_PATH)}`);
}

async function applyRebuild(opts) {
	const redisHighWater = await readRedisHighWater();
	const before = collectStatus(redisHighWater);
	const doBuild = !opts.copyOnly;
	const doCopy = !opts.buildOnly;
	const useLocalRedis = !opts.noLocalRedis;

	if (doBuild) {
		console.log(`\n==> Building search indexes (USE_LOCAL_REDIS=${useLocalRedis ? '1' : '0'})`);
		await runNodeScript('.local/scripts/build_search_indexes.js', {
			USE_LOCAL_REDIS: useLocalRedis ? '1' : '0',
			NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192',
		});
	} else {
		console.log('\n==> Skipping build (--copy-only)');
	}

	if (doCopy) {
		console.log('\n==> Copying sidecars to public/search-indexes/');
		await runNodeScript('.local/scripts/copy-search-indexes.js');
	} else {
		console.log('\n==> Skipping copy (--build-only)');
	}

	const after = collectStatus(await readRedisHighWater());
	const changed = [];
	for (const bucket of after.buckets) {
		const beforeBucket = before.buckets.find((b) => b.name === bucket.name);
		const natChanged = beforeBucket?.national?.mtime !== bucket.national.mtime || beforeBucket?.national?.bytes !== bucket.national.bytes;
		const pubChanged = beforeBucket?.public?.mtime !== bucket.public.mtime || beforeBucket?.public?.bytes !== bucket.public.bytes;
		if (natChanged || pubChanged) {
			changed.push({
				name: bucket.name,
				national: bucket.national,
				public: bucket.public,
				nationalChanged: Boolean(natChanged),
				publicChanged: Boolean(pubChanged),
			});
		}
	}

	const report = {
		ok: true,
		finishedAt: new Date().toISOString(),
		options: {
			build: doBuild,
			copy: doCopy,
			useLocalRedis,
		},
		before,
		after,
		changed,
		nextSteps: [
			'Review git diff for public/search-indexes/* (data/national is gitignored local cache)',
			'Commit public sidecar updates when ready',
			'Deploy so Vercel serves the new public/search-indexes gzip files',
		],
	};
	writeReport(report);
	printStatus(after);
	if (changed.length) {
		console.log(`\nChanged ${changed.length} bucket(s):`);
		for (const entry of changed) {
			console.log(`  - ${entry.name} (national=${entry.nationalChanged}, public=${entry.publicChanged})`);
		}
	} else {
		console.log('\nNo sidecar mtime/size changes detected.');
	}
	return report;
}

function printHelp() {
	console.log(`rebuild_search_sidecars.mjs

Local rebuild + publish for search sidecars (commit/deploy afterward).

  --status           Show national/public ages and sizes (default if no --apply)
  --apply            Build from Redis/disk then copy to public/
  --build-only       With --apply: only run build_search_indexes.js
  --copy-only        With --apply: only run copy-search-indexes.js
  --no-local-redis   With --apply: do not set USE_LOCAL_REDIS=1

pnpm:
  pnpm run sidecars:status
  pnpm run sidecars:rebuild
`);
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help && !opts.apply && !opts.status) {
		printHelp();
		return;
	}
	if (!opts.apply) {
		const status = collectStatus(await readRedisHighWater());
		printStatus(status);
		writeReport({ ok: true, mode: 'status', ...status });
		return;
	}
	await applyRebuild(opts);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
	main().catch((error) => {
		console.error('rebuild_search_sidecars failed:', error?.message || error);
		process.exit(1);
	});
}
