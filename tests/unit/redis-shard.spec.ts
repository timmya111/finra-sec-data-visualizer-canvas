import { describe, expect, it } from 'vitest';
import {
	DEFAULT_REDIS_SHARD,
	extractRoutingKeys,
	partitionKeysByShard,
	readShardEnvConfig,
	resolveRedisShard,
	resolveShardForCommand,
} from '@/lib/redisShard';

describe('redisShard routing', () => {
	it('keeps FINRA+SEC individuals on the individual shard', () => {
		expect(resolveRedisShard('finra:individual:1085996')).toBe('individual');
		expect(resolveRedisShard('sec:individual:1085996')).toBe('individual');
		expect(resolveRedisShard('finra:individual:*')).toBe('individual');
		expect(resolveRedisShard('non-live-crds:individual:1')).toBe('individual');
		expect(resolveRedisShard('dashboard:highest-crds:individual')).toBe('individual');
		expect(resolveRedisShard('finra:selection-refresh:checked:individual:9')).toBe('individual');
	});

	it('keeps FINRA+SEC firms and connections on the firm shard', () => {
		expect(resolveRedisShard('finra:firm:11068')).toBe('firm');
		expect(resolveRedisShard('sec:firm:11068')).toBe('firm');
		expect(resolveRedisShard('firm-connections:firm:6363')).toBe('firm');
		expect(resolveRedisShard('sec:firm:6363_brokers:current')).toBe('firm');
		expect(resolveRedisShard('non-live-crds:firm:1')).toBe('firm');
		expect(resolveRedisShard('dashboard:highest-crds:firm')).toBe('firm');
		expect(resolveRedisShard('finra:selection-refresh:checked:firm:9')).toBe('firm');
	});

	it('defaults shared control keys to the firm shard', () => {
		expect(resolveRedisShard('finra:selection-refresh:backoffUntil')).toBe('firm');
		expect(resolveRedisShard('dashboard:cached-crd-count')).toBe('firm');
		expect(resolveRedisShard('dashboard:new-crds-cache')).toBe('firm');
		expect(resolveRedisShard('unknown:key')).toBe(DEFAULT_REDIS_SHARD);
	});

	it('partitions mixed key lists', () => {
		const parts = partitionKeysByShard([
			'finra:individual:1',
			'finra:firm:2',
			'sec:individual:3',
			'firm-connections:firm:4',
		]);
		expect(parts.individual).toEqual(['finra:individual:1', 'sec:individual:3']);
		expect(parts.firm).toEqual(['finra:firm:2', 'firm-connections:firm:4']);
	});

	it('extracts mget / scan routing keys', () => {
		expect(extractRoutingKeys('mget', ['a', 'b'])).toEqual(['a', 'b']);
		expect(extractRoutingKeys('mget', [['a', 'b']])).toEqual(['a', 'b']);
		expect(extractRoutingKeys('scan', [0, { match: 'finra:individual:*', count: 100 }])).toEqual([
			'finra:individual:*',
		]);
		expect(extractRoutingKeys('set', ['finra:firm:1', 'x'])).toEqual(['finra:firm:1']);
	});

	it('resolves single-key commands to one shard', () => {
		expect(resolveShardForCommand('get', ['sec:individual:1'])).toBe('individual');
		expect(resolveShardForCommand('set', ['firm-connections:firm:1', '{}'])).toBe('firm');
		expect(resolveShardForCommand('scan', [0, { match: 'sec:firm:*' }])).toBe('firm');
	});

	it('maps env: REST_URL = individuals, MIRROR = firms', () => {
		const cfg = readShardEnvConfig({
			UPSTASH_REDIS_REST_URL: 'https://ind.example',
			UPSTASH_REDIS_REST_TOKEN: 'ind-token',
			UPSTASH_REDIS_REST_URL_MIRROR: 'https://firm.example',
			UPSTASH_REDIS_REST_TOKEN_MIRROR: 'firm-token',
		} as NodeJS.ProcessEnv);
		expect(cfg.individual).toEqual({ url: 'https://ind.example', token: 'ind-token' });
		expect(cfg.firm).toEqual({ url: 'https://firm.example', token: 'firm-token' });
	});

	it('prefers explicit INDIVIDUAL/FIRM env aliases', () => {
		const cfg = readShardEnvConfig({
			UPSTASH_REDIS_REST_URL: 'https://legacy-ind',
			UPSTASH_REDIS_REST_TOKEN: 'legacy',
			UPSTASH_REDIS_INDIVIDUAL_URL: 'https://ind2',
			UPSTASH_REDIS_INDIVIDUAL_TOKEN: 'ind2',
			UPSTASH_REDIS_FIRM_URL: 'https://firm2',
			UPSTASH_REDIS_FIRM_TOKEN: 'firm2',
		} as NodeJS.ProcessEnv);
		expect(cfg.individual?.url).toBe('https://ind2');
		expect(cfg.firm?.url).toBe('https://firm2');
	});
});
