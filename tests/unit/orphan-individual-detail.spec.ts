import { describe, expect, it } from 'vitest';
import { applyIndividualDetail } from '@/lib/finra-graph/detailUtils';
import { buildParentFirmSummaryLinks } from '@/lib/finra-graph/externalLinks';

describe('non-live / orphan individual detail', () => {
	it('synthesizes a parent-firm employment card for non-live CRDs', () => {
		const node: any = { id: 'person:1090661', group: 'individual', label: 'Person 1090661' };
		applyIndividualDetail(
			node,
			{
				found: true,
				orphan: {
					crd: '1090661',
					name: 'RUETHER, JULIE ANN',
					position: 'CHIEF COMPLIANCE OFFICER',
					firmName: 'IDS LIFE INSURANCE COMPANY',
					parentCrd: '6321',
					parentType: 'firm',
				},
			},
			'1090661',
		);

		expect(node.stub).toBe(true);
		expect(node.orphanParentCrd).toBe('6321');
		expect(node.orphanPosition).toMatch(/CHIEF COMPLIANCE OFFICER/i);
		expect(node.bcScope).toBe('Active');
		expect(node._vizInactive).toBe(false);
		expect(node.inactive).toBe(false);
		expect(node.currentEmployments).toEqual([
			expect.objectContaining({
				firmId: '6321',
				firmName: 'IDS LIFE INSURANCE COMPANY',
				position: 'CHIEF COMPLIANCE OFFICER',
				_orphanAffiliation: true,
			}),
		]);
		expect(String(node.label)).toMatch(/Julie|RUETHER/i);
	});

	it('inherits Active firmStatus onto Emtemark-style MEMBER orphans and clears viz inactive', () => {
		const node: any = { id: 'person:6378495', group: 'individual', label: 'Person 6378495', _vizInactive: true };
		applyIndividualDetail(
			node,
			{
				found: true,
				orphan: {
					crd: '6378495',
					name: 'EMTEMARK, PHILIP RAYMOND',
					position: 'MEMBER',
					firmName: 'BERKSHIRE GLOBAL ADVISORS LP',
					parentCrd: '124180',
					parentType: 'firm',
					firmStatus: 'ACTIVE',
				},
			},
			'6378495',
		);

		expect(node.stub).toBe(true);
		expect(node.bcScope).toBe('Active');
		expect(node.firmStatus).toBe('ACTIVE');
		expect(node.inactive).toBe(false);
		expect(node._vizInactive).toBe(false);
		expect(node.controlPositions).toEqual([
			expect.objectContaining({ firmId: '124180', position: 'MEMBER' }),
		]);
	});

	it('marks non-live orphans inactive when the parent firm status is inactive', () => {
		const node: any = { id: 'person:1', group: 'individual', label: 'Person 1' };
		applyIndividualDetail(
			node,
			{
				found: true,
				orphan: {
					crd: '1',
					name: 'INACTIVE OWNER',
					position: 'MEMBER',
					firmName: 'DEAD FIRM',
					parentCrd: '99',
					parentType: 'firm',
					firmStatus: 'Inactive',
				},
			},
			'1',
		);

		expect(node.bcScope).toBe('Inactive');
		expect(node.inactive).toBe(true);
		expect(node._vizInactive).toBe(true);
	});

	it('keeps parent-firm employment card fields for Schwarzmann-style CEO/COB orphans', () => {
		const node: any = { id: 'person:4742555', group: 'individual', label: 'Person 4742555', stub: true, bcScope: 'NotInScope' };
		applyIndividualDetail(
			node,
			{
				found: true,
				orphan: {
					crd: '4742555',
					name: 'SCHWARZMANN, MARK EDWARD',
					position: 'DIRECTOR, CEO, COB',
					firmName: 'IDS LIFE INSURANCE COMPANY',
					parentCrd: '6321',
					parentType: 'firm',
				},
			},
			'4742555',
		);

		expect(node.currentEmployments).toEqual([
			expect.objectContaining({
				firmId: '6321',
				firmName: 'IDS LIFE INSURANCE COMPANY',
				position: 'DIRECTOR, CEO, COB',
				_orphanAffiliation: true,
			}),
		]);
		expect(node.hasFinraData).toBe(false);
		expect(node.orphanParentCrd).toBe('6321');
	});

	it('uses the SEC registration number for SEC summary links instead of the CRD', () => {
		const links = buildParentFirmSummaryLinks({
			bcScope: 'Active',
			currentEmployments: [{ firmId: '37404' }],
			iaSecNumber: '8-47739',
			basicInformation: { iaSECNumber: '8-47739' },
		});

		expect(links.find((link) => link.className === 'sec')?.href).toBe('https://adviserinfo.sec.gov/firm/summary/8-47739');
	});
});
