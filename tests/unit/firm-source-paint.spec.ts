import { describe, expect, it } from 'vitest';
import {
	FIRM_BOTH_FILL,
	FIRM_BOTH_STROKE,
	FIRM_FINRA_ONLY_FILL,
	FIRM_SEC_ONLY_FILL,
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
