import { describe, expect, it } from 'vitest';

import {
	connectionMatchesClickRevealKeyword,
	DEFAULT_FIRM_REVEAL_LIMIT,
	graphSearchConfigQueryKeyPart,
	graphSearchConfigToLegacySearchType,
	nodeMatchesClickRevealKeyword,
	normalizeFirmRevealLimit,
	normalizeGraphSearchClickConfig,
	normalizeGraphSearchScope,
	searchConfigActivityMode,
	searchConfigIncludesFirms,
	searchConfigIncludesPeople,
} from '@/lib/graphSearchClickConfig';

describe('graphSearchClickConfig', () => {
	it('normalizes scope and firm-only click reveal settings; people stay uncapped', () => {
		expect(normalizeGraphSearchScope('FIRMS')).toBe('firms');
		expect(normalizeGraphSearchScope('nope')).toBe('people');
		expect(normalizeFirmRevealLimit(0)).toBe(DEFAULT_FIRM_REVEAL_LIMIT);
		expect(normalizeFirmRevealLimit(250)).toBe(250);
		expect(normalizeFirmRevealLimit(9999)).toBe(500);
		const config = normalizeGraphSearchClickConfig({
			searchScope: 'firms',
			includeInactive: true,
			firmRevealLimit: 40,
			firmRevealPrevious: true,
			clickRevealKeyword: '  hopper  ',
			// Legacy field from older persisted configs must be ignored.
			peopleRevealPrevious: false,
		} as any);
		expect(config).toEqual({
			searchScope: 'firms',
			includeInactive: true,
			firmRevealLimit: 40,
			firmRevealPrevious: true,
			clickRevealKeyword: 'hopper',
		});
		expect(config).not.toHaveProperty('peopleRevealPrevious');
		expect(config).not.toHaveProperty('peopleRevealLimit');
	});

	it('maps include-inactive to active+inactive (no inactive-only mode)', () => {
		expect(searchConfigIncludesPeople('all')).toBe(true);
		expect(searchConfigIncludesFirms('people')).toBe(false);
		expect(searchConfigActivityMode({ searchScope: 'people', includeInactive: false })).toBe('active');
		expect(searchConfigActivityMode({ searchScope: 'people', includeInactive: true })).toBeNull();
		expect(graphSearchConfigQueryKeyPart({ searchScope: 'people', includeInactive: true })).toBe('people:inactive');
		expect(graphSearchConfigToLegacySearchType({ searchScope: 'people', includeInactive: true })).toBe('people-inactive');
	});

	it('matches firm click-reveal keyword tokens against node/connection fields', () => {
		expect(nodeMatchesClickRevealKeyword({ label: 'Jane Hopper', crd: '123' }, '')).toBe(true);
		expect(nodeMatchesClickRevealKeyword({ label: 'Jane Hopper', crd: '123' }, 'hopper')).toBe(true);
		expect(nodeMatchesClickRevealKeyword({ label: 'Jane Hopper', crd: '123' }, 'hopper 999')).toBe(false);
		expect(connectionMatchesClickRevealKeyword({ name: 'Jane Hopper', crd: '55' }, '55')).toBe(true);
		expect(connectionMatchesClickRevealKeyword({ firstName: 'Jane', lastName: 'Doe' }, 'hopper')).toBe(false);
	});
});
