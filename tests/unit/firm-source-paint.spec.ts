import { describe, expect, it } from 'vitest';
import {
	FIRM_BOTH_FILL,
	FIRM_BOTH_STROKE,
	FIRM_FINRA_ONLY_FILL,
	FIRM_SEC_ONLY_FILL,
	applyFirmSourceFieldsToNode,
	extractFirmSourceFields,
	getFirmSourceCoverage,
	getFirmSourcePaintStyle,
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

	it('paints SEC-only green, FINRA-only purple, both purple with green border', () => {
		expect(getFirmSourcePaintStyle({ hasSecData: true, hasFinraData: false })).toMatchObject({
			coverage: 'sec_only',
			fill: FIRM_SEC_ONLY_FILL,
			className: 'fg-node--sec-only',
		});
		expect(getFirmSourcePaintStyle({ hasSecData: false, hasFinraData: true })).toMatchObject({
			coverage: 'finra_only',
			fill: FIRM_FINRA_ONLY_FILL,
			className: 'fg-node--finra-only',
		});
		const both = getFirmSourcePaintStyle({ hasSecData: true, hasFinraData: true });
		expect(both.coverage).toBe('both');
		expect(both.fill).toBe(FIRM_BOTH_FILL);
		expect(both.stroke).toBe(FIRM_BOTH_STROKE);
		expect(both.fill).toBe(FIRM_FINRA_ONLY_FILL);
		expect(both.stroke).toBe(FIRM_SEC_ONLY_FILL);
		expect(both.className).toBe('fg-node--finra-sec');
	});

	it('keeps FINRA and SEC fills at similar relative luminance', () => {
		const rel = (hex: string) => {
			const h = hex.replace('#', '');
			const toLin = (c: number) => {
				const s = c / 255;
				return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
			};
			const r = toLin(parseInt(h.slice(0, 2), 16));
			const g = toLin(parseInt(h.slice(2, 4), 16));
			const b = toLin(parseInt(h.slice(4, 6), 16));
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		expect(Math.abs(rel(FIRM_SEC_ONLY_FILL) - rel(FIRM_FINRA_ONLY_FILL))).toBeLessThan(0.06);
	});
});
