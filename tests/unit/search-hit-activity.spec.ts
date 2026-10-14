import { describe, expect, it } from 'vitest';
import {
	inferFirmIaScopeFromStrictSearchText,
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

	it('infers SEC firm IA scope from strictSearchText and excludes inactive IA firms from active Firms', () => {
		const fisher = {
			_id: '107342',
			_source: {
				firm_id: '107342',
				firmName: 'FISHER INVESTMENTS',
				firm_bc_scope: '',
				iaSecNumber: '29362',
				strictSearchText: '107342 fisher investments active y not requested 04/02/2026 29362',
			},
		};
		const dfj = {
			_id: '162462',
			_source: {
				firm_id: '162462',
				firmName: 'DFJ EPLANET',
				firm_bc_scope: '',
				iaSecNumber: '75168',
				strictSearchText: '162462 dfj eplanet inactive y not requested 04/19/2021 75168',
			},
		};
		expect(inferFirmIaScopeFromStrictSearchText(fisher._source.strictSearchText)).toBe('ACTIVE');
		expect(inferFirmIaScopeFromStrictSearchText(dfj._source.strictSearchText)).toBe('INACTIVE');
		expect(searchHitLooksActive(fisher, 'firm')).toBe(true);
		expect(searchHitLooksInactive(fisher, 'firm')).toBe(false);
		expect(searchHitLooksActive(dfj, 'firm')).toBe(false);
		expect(searchHitLooksInactive(dfj, 'firm')).toBe(true);
		expect(searchHitMatchesActivityFilter(dfj, { kind: 'firm', mode: 'inactive' })).toBe(true);
		// Bare iaSecNumber without scope/text must not pretend the firm is active.
		expect(searchHitLooksActive({ firm_id: '3', firm_bc_scope: '', iaSecNumber: '99' }, 'firm')).toBe(false);
		expect(searchHitLooksActive({ firm_id: '1', firm_bc_scope: '', firm_ia_scope: 'ACTIVE' }, 'firm')).toBe(true);
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
