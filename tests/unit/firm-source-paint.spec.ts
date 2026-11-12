import { describe, expect, it } from 'vitest';
import {
	FIRM_BOTH_STROKE,
	FIRM_EXHAUSTED_FILL,
	FIRM_EXHAUSTED_STROKE,
	FIRM_SEC_ONLY_FILL,
	FIRM_SELECTED_FILL,
	applyFirmSourceFieldsToNode,
	extractFirmSourceFields,
	getFirmSourceCoverage,
	getFirmSourcePaintStyle,
	isFirmRosterRevealExhausted,
} from '@/lib/firmSourcePaint';

describe('firmSourcePaint', () => {
	it('classifies SEC-only, FINRA-only, and both from source flags', () => {
		expect(getFirmSourceCoverage({ group: 'firm', hasSecData: true, hasFinraData: false })).toBe('sec_only');
		expect(getFirmSourceCoverage({ group: 'firm', hasSecData: false, hasFinraData: true })).toBe('finra_only');
		expect(getFirmSourceCoverage({ group: 'firm', hasSecData: true, hasFinraData: true })).toBe('both');
		expect(getFirmSourceCoverage({ group: 'firm', hasSecData: false, hasFinraData: false })).toBe('none');
	});

	it('extractFirmSourceFields maps iaSECNumber and scopes onto paint flags before select', () => {
		const finraOnly = extractFirmSourceFields({
			basicInformation: { firmId: 8217, firmName: 'FINRA Only', bcScope: 'ACTIVE' },
		});
		expect(finraOnly).toMatchObject({ hasFinraData: true, hasSecData: false, bcScope: 'ACTIVE' });
		expect(getFirmSourceCoverage(finraOnly)).toBe('finra_only');

		const secOnly = extractFirmSourceFields({
			basicInformation: { firmId: 107319, firmName: 'SEC Only', iaScope: 'ACTIVE', iaSECNumber: '42910' },
		});
		expect(secOnly).toMatchObject({ hasFinraData: false, hasSecData: true, iaScope: 'ACTIVE', iaSecNumber: '42910' });
		expect(getFirmSourceCoverage(secOnly)).toBe('sec_only');

		const both = extractFirmSourceFields({
			basicInformation: {
				firmId: 16164,
				firmName: 'Both',
				bcScope: 'ACTIVE',
				iaScope: 'ACTIVE',
				iaSECNumber: '38618',
			},
			hasFinraData: true,
			hasSecData: true,
		});
		expect(both).toMatchObject({ hasFinraData: true, hasSecData: true });
		expect(getFirmSourceCoverage(both)).toBe('both');
	});

	it('applyFirmSourceFieldsToNode stamps paint flags onto a fetched firm stub', () => {
		const node: any = { id: 'firm:107319', group: 'firm', firmId: '107319', label: 'SEC Only Stub' };
		applyFirmSourceFieldsToNode(node, {
			basicInformation: { firmId: 107319, iaScope: 'ACTIVE', iaSECNumber: '42910' },
			hasFinraData: false,
			hasSecData: true,
		});
		expect(node.hasFinraData).toBe(false);
		expect(node.hasSecData).toBe(true);
		expect(node.iaScope).toBe('ACTIVE');
		expect(node.iaSecNumber).toBe('42910');
		expect(getFirmSourceCoverage(node)).toBe('sec_only');
	});

	it('does not treat BrokerCheck firmStatus Approved as SEC coverage', () => {
		expect(
			getFirmSourceCoverage({
				group: 'firm',
				hasFinraData: true,
				hasSecData: false,
				bcScope: 'ACTIVE',
				firmStatus: 'Approved',
			}),
		).toBe('finra_only');
	});

	it('clears a polluted iaSecNumber that was copied from bdSECNumber on FINRA-only hydrate', () => {
		const node: any = {
			id: 'firm:8217',
			group: 'firm',
			firmId: '8217',
			hasFinraData: true,
			hasSecData: false,
			bcScope: 'ACTIVE',
			firmStatus: 'Approved',
			// Prior bug: ensureFirmDetail stamped bdSECNumber onto iaSecNumber.
			iaSecNumber: '24829',
			bdSecNumber: '24829',
		};
		applyFirmSourceFieldsToNode(node, {
			hasFinraData: true,
			hasSecData: false,
			basicInformation: {
				firmId: 8217,
				firmName: 'TRANSAMERICA CAPITAL, LLC',
				bcScope: 'ACTIVE',
				firmStatus: 'Approved',
				bdSECNumber: '24829',
			},
		});
		expect(node.hasFinraData).toBe(true);
		expect(node.hasSecData).toBe(false);
		expect(node.iaSecNumber).toBeNull();
		expect(node.bdSecNumber).toBe('24829');
		expect(getFirmSourceCoverage(node)).toBe('finra_only');
	});

	it('paints every firm coverage with the same green', () => {
		expect(getFirmSourcePaintStyle({ group: 'firm', hasSecData: true, hasFinraData: false })).toMatchObject({
			coverage: 'sec_only',
			fill: FIRM_SEC_ONLY_FILL,
			stroke: expect.any(String),
			className: 'fg-node--firm-green',
			exhausted: false,
		});
		expect(getFirmSourcePaintStyle({ group: 'firm', hasSecData: false, hasFinraData: true })).toMatchObject({
			coverage: 'finra_only',
			fill: FIRM_SEC_ONLY_FILL,
			className: 'fg-node--firm-green',
		});
		const both = getFirmSourcePaintStyle({ group: 'firm', hasSecData: true, hasFinraData: true });
		expect(both.coverage).toBe('both');
		expect(both.fill).toBe(FIRM_SEC_ONLY_FILL);
		expect(both.stroke).toBe(FIRM_BOTH_STROKE);
		expect(both.className).toBe('fg-node--firm-green');
	});

	it('darkens selected firms and exhausted roster firms while staying green', () => {
		const selected = getFirmSourcePaintStyle({ group: 'firm', hasSecData: true, hasFinraData: true }, { selected: true });
		expect(selected.fill).toBe(FIRM_SELECTED_FILL);
		expect(selected.exhausted).toBe(false);

		const exhaustedNode = {
			group: 'firm',
			hasSecData: false,
			hasFinraData: true,
			_secOnlyCurrentConnectionsExpanded: true,
			currentConnections: [{ individualId: '1' }],
		};
		expect(isFirmRosterRevealExhausted(exhaustedNode)).toBe(true);
		const exhausted = getFirmSourcePaintStyle(exhaustedNode);
		expect(exhausted.fill).toBe(FIRM_EXHAUSTED_FILL);
		expect(exhausted.stroke).toBe(FIRM_EXHAUSTED_STROKE);
		expect(exhausted.className).toContain('fg-node--roster-exhausted');
		expect(exhausted.exhausted).toBe(true);

		// Loaded-empty connections alone must not darken (BD/control firms, failed empty loads).
		const emptyLoaded = {
			group: 'firm',
			hasSecData: true,
			hasFinraData: true,
			_connectionsLoaded: true,
			currentConnections: [],
		};
		expect(isFirmRosterRevealExhausted(emptyLoaded)).toBe(false);
		expect(getFirmSourcePaintStyle(emptyLoaded).exhausted).toBe(false);
		expect(getFirmSourcePaintStyle(emptyLoaded).fill).toBe(FIRM_SEC_ONLY_FILL);
	});
});
