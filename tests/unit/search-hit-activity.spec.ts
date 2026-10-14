import { describe, expect, it } from 'vitest';
import {
	searchHitLooksActive,
	searchHitLooksInactive,
	searchHitMatchesActivityFilter,
	searchTypeActivityFilter,
	searchTypeIncludesFirms,
	searchTypeIncludesPeople,
	searchTypeWantsActiveOnly,
	searchTypeWantsInactiveOnly,
} from '@/lib/searchHitActivity';

describe('searchHitActivity', () => {
	it('classifies active and inactive people and firms from scope/status fields', () => {
		expect(
			searchHitLooksInactive(
				{ ind_source_id: '1', ind_bc_scope: 'InActive', ind_ia_scope: 'InActive' },
				'individual',
			),
		).toBe(true);
		expect(searchHitLooksInactive({ ind_source_id: '2', ind_bc_scope: 'Active', ind_ia_scope: 'InActive' }, 'individual')).toBe(false);
		expect(searchHitLooksActive({ ind_source_id: '2', ind_bc_scope: 'Active', ind_ia_scope: 'InActive' }, 'individual')).toBe(true);
		expect(searchHitLooksActive({ ind_source_id: '1', ind_bc_scope: 'InActive', ind_ia_scope: 'InActive' }, 'individual')).toBe(false);
		expect(searchHitLooksInactive({ firm_id: '3', firm_bc_scope: 'INACTIVE' }, 'firm')).toBe(true);
		expect(searchHitLooksInactive({ firm_id: '4', firm_bc_scope: 'ACTIVE' }, 'firm')).toBe(false);
		expect(searchHitLooksActive({ firm_id: '4', firm_bc_scope: 'ACTIVE' }, 'firm')).toBe(true);
	});

	it('maps header search types to request and activity filters', () => {
		expect(searchTypeIncludesPeople('people-inactive')).toBe(true);
		expect(searchTypeIncludesFirms('people-inactive')).toBe(false);
		expect(searchTypeIncludesFirms('firms-inactive')).toBe(true);
		expect(searchTypeActivityFilter('people')).toEqual({ kind: 'individual', mode: 'active' });
		expect(searchTypeActivityFilter('people-inactive')).toEqual({ kind: 'individual', mode: 'inactive' });
		expect(searchTypeActivityFilter('firms')).toEqual({ kind: 'firm', mode: 'active' });
		expect(searchTypeActivityFilter('firms-inactive')).toEqual({ kind: 'firm', mode: 'inactive' });
		expect(searchTypeActivityFilter('all')).toBeNull();
		expect(searchTypeWantsActiveOnly('people')).toBe('individual');
		expect(searchTypeWantsInactiveOnly('people-inactive')).toBe('individual');
		expect(searchTypeWantsInactiveOnly('people')).toBeNull();
		expect(
			searchHitMatchesActivityFilter(
				{ ind_source_id: '2', ind_bc_scope: 'Active' },
				{ kind: 'individual', mode: 'active' },
			),
		).toBe(true);
		expect(
			searchHitMatchesActivityFilter(
				{ ind_source_id: '1', ind_bc_scope: 'InActive', ind_ia_scope: 'InActive' },
				{ kind: 'individual', mode: 'active' },
			),
		).toBe(false);
	});
});
