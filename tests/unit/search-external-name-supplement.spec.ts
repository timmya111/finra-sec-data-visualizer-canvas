import { describe, expect, it } from 'vitest';
import { externalHitMatchesNameQuery, tokensFuzzyMatch } from '@/lib/searchExternalNameSupplement';

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
});
