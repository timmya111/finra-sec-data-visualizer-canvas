import { describe, expect, it } from 'vitest';
import {
	EXTERNAL_NAME_SUPPLEMENT_MAX_PAGES,
	externalHitMatchesNameQuery,
	shouldAwaitExternalNameSupplement,
	tokensFuzzyMatch,
} from '@/lib/searchExternalNameSupplement';

describe('searchExternalNameSupplement filters', () => {
	it('keeps Hopper/Hooper/Hoppe and drops Cooper', () => {
		expect(tokensFuzzyMatch('hopper', 'hopper')).toBe(true);
		expect(tokensFuzzyMatch('hopper', 'hooper')).toBe(true);
		expect(tokensFuzzyMatch('hopper', 'hoppe')).toBe(true);
		expect(tokensFuzzyMatch('hopper', 'cooper')).toBe(false);
		expect(tokensFuzzyMatch('hopper', 'topper')).toBe(false);

		expect(externalHitMatchesNameQuery({ _source: { ind_lastname: 'Hopper', ind_firstname: 'Ann' } }, 'hopper')).toBe(true);
		expect(externalHitMatchesNameQuery({ _source: { ind_lastname: 'Hooper', ind_firstname: 'Ann' } }, 'hopper')).toBe(true);
		expect(externalHitMatchesNameQuery({ _source: { ind_lastname: 'Hopperstad', ind_firstname: 'Ann' } }, 'hopper')).toBe(true);
		expect(externalHitMatchesNameQuery({ _source: { ind_lastname: 'Cooper', ind_firstname: 'Ann' } }, 'hopper')).toBe(false);
	});

	it('awaits external name supplement only when the local page is thin', () => {
		expect(EXTERNAL_NAME_SUPPLEMENT_MAX_PAGES).toBeLessThanOrEqual(3);
		expect(
			shouldAwaitExternalNameSupplement({
				entity: 'individual',
				query: 'smith',
				localHitCount: 12,
				limit: 12,
			}),
		).toBe(false);
		expect(
			shouldAwaitExternalNameSupplement({
				entity: 'individual',
				query: 'smith',
				localHitCount: 3,
				limit: 12,
			}),
		).toBe(true);
		expect(
			shouldAwaitExternalNameSupplement({
				entity: 'individual',
				query: '2546581',
				localHitCount: 0,
				limit: 12,
			}),
		).toBe(false);
		expect(
			shouldAwaitExternalNameSupplement({
				entity: 'firm',
				query: 'merrill',
				localHitCount: 0,
				limit: 12,
			}),
		).toBe(false);
	});
});
