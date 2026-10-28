import { describe, expect, it } from 'vitest';
import {
	collectSessionRestoreIdsFromPositions,
	sessionRestorableNodeWeight,
} from '../../src/lib/finra-graph';

describe('session restore from nodePositions (minimal/quota downgrade)', () => {
	it('collects unique ids from saved positions when extras were stripped', () => {
		expect(
			collectSessionRestoreIdsFromPositions({
				extraNodes: [],
				extraNodeIds: [],
				nodePositions: [
					{ id: 'person:999888', x: 10, y: 20 },
					{ id: 'firm:555444', x: 30, y: 40 },
					{ id: 'person:999888', x: 11, y: 21 },
					{ id: '', x: 0, y: 0 },
					null,
				],
			}),
		).toEqual(['person:999888', 'firm:555444']);
	});

	it('weights position-only sessions above empty selected-only stubs', () => {
		expect(sessionRestorableNodeWeight({ selectedNodeId: 'person:1', highlightedNodes: [{ id: 'person:1' }] })).toBe(0);
		expect(
			sessionRestorableNodeWeight({
				selectedNodeId: 'person:1',
				nodePositions: [
					{ id: 'person:1', x: 1, y: 2 },
					{ id: 'firm:2', x: 3, y: 4 },
				],
			}),
		).toBe(2);
		expect(
			sessionRestorableNodeWeight({
				extraNodes: [{ id: 'person:1' }],
				nodePositions: [{ id: 'person:1', x: 1, y: 2 }],
			}),
		).toBe(1);
	});
});
