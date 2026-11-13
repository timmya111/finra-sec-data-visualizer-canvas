import { describe, expect, it } from 'vitest';

import {
	connectionMatchesClickRevealKeyword,
	DEFAULT_FIRM_REVEAL_LIMIT,
	graphSearchConfigQueryKeyPart,
	graphSearchConfigToLegacySearchType,
	matchesClickRevealKeywords,
	normalizeFirmRevealLimit,
	normalizeGraphSearchClickConfig,
	normalizeGraphSearchScope,
	parseClickRevealKeywordTags,
	searchConfigActivityMode,
	searchConfigIncludesFirms,
	searchConfigIncludesPeople,
	searchHitMatchesSearchQuery,
} from '@/lib/graphSearchClickConfig';

describe('graphSearchClickConfig', () => {
	it('normalizes scope and firm-only click reveal settings with keyword tags', () => {
		expect(normalizeGraphSearchScope('FIRMS')).toBe('firms');
		expect(normalizeGraphSearchScope('nope')).toBe('people');
		expect(normalizeFirmRevealLimit(0)).toBe(DEFAULT_FIRM_REVEAL_LIMIT);
		expect(normalizeFirmRevealLimit(250)).toBe(250);
		expect(normalizeFirmRevealLimit(9999)).toBe(500);
		const config = normalizeGraphSearchClickConfig({
			searchScope: 'firms',
			includeInactive: true,
			searchStrict: true,
			firmRevealLimit: 40,
			firmRevealPrevious: true,
			clickRevealKeywords: ['  hopper  ', 'smith'],
			clickRevealStrict: true,
			// Legacy single-string field migrates into tags.
			clickRevealKeyword: 'ignored-when-array-present',
		} as any);
		expect(config).toEqual({
			searchScope: 'firms',
			includeInactive: true,
			searchStrict: true,
			firmRevealLimit: 40,
			firmRevealPrevious: true,
			clickRevealKeywords: ['hopper', 'smith'],
			clickRevealStrict: true,
		});
		expect(normalizeGraphSearchClickConfig({ clickRevealKeyword: 'jane, hopper' } as any).clickRevealKeywords).toEqual([
			'jane',
			'hopper',
		]);
		expect(parseClickRevealKeywordTags('a, a, B')).toEqual(['a', 'B']);
	});

	it('maps include-inactive to active+inactive (no inactive-only mode)', () => {
		expect(searchConfigIncludesPeople('all')).toBe(true);
		expect(searchConfigIncludesFirms('people')).toBe(false);
		expect(searchConfigActivityMode({ searchScope: 'people', includeInactive: false })).toBe('active');
		expect(searchConfigActivityMode({ searchScope: 'people', includeInactive: true })).toBeNull();
		expect(graphSearchConfigQueryKeyPart({ searchScope: 'people', includeInactive: true, searchStrict: false })).toBe(
			'people:inactive:fuzzy',
		);
		expect(graphSearchConfigQueryKeyPart({ searchScope: 'people', includeInactive: false, searchStrict: true })).toBe(
			'people:active:strict',
		);
		expect(graphSearchConfigToLegacySearchType({ searchScope: 'people', includeInactive: true })).toBe('people-inactive');
	});

	it('matches firm click-reveal tags with fuzzy or strict modes', () => {
		expect(matchesClickRevealKeywords('Jane Hopper', [], false)).toBe(true);
		// Fuzzy: tokens anywhere
		expect(matchesClickRevealKeywords('Jane Ann Hopper', ['jane hopper'], false)).toBe(true);
		expect(connectionMatchesClickRevealKeyword({ name: 'Jane Hopper', crd: '55' }, ['55'], false)).toBe(true);
		expect(connectionMatchesClickRevealKeyword({ firstName: 'Jane', lastName: 'Doe' }, ['hopper'], false)).toBe(false);
		// Strict: contiguous phrase required
		expect(matchesClickRevealKeywords('Jane Ann Hopper', ['jane hopper'], true)).toBe(false);
		expect(matchesClickRevealKeywords('Jane Hopper Smith', ['jane hopper'], true)).toBe(true);
		// OR across tags
		expect(matchesClickRevealKeywords('Bob Smith', ['hopper', 'smith'], true)).toBe(true);
	});

	it('filters header search hits with searchStrict exact-phrase matching', () => {
		const hit = {
			_source: {
				ind_firstname: 'Jane',
				ind_middlename: 'Ann',
				ind_lastname: 'Hopper',
				ind_crd: '55',
			},
		};
		expect(searchHitMatchesSearchQuery(hit, 'jane hopper', false)).toBe(true);
		expect(searchHitMatchesSearchQuery(hit, 'jane hopper', true)).toBe(false);
		expect(searchHitMatchesSearchQuery(hit, 'ann hopper', true)).toBe(true);
		expect(searchHitMatchesSearchQuery(hit, '55', true)).toBe(true);
	});
});
