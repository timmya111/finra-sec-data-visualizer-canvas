/**
 * Browser-side deferred selection refresh: wait for animation settle, then
 * POST /api/finra/selection-refresh. Kept separate from finra-graph.ts for tests.
 */

export type SelectionRefreshClientKind = 'individual' | 'firm';

export type SelectionRefreshClientResult = {
	ok?: boolean;
	updated?: boolean;
	unchanged?: boolean;
	skipped?: string;
	rateLimited?: boolean;
	resumeAt?: number;
	backoffMs?: number;
	detail?: Record<string, unknown> | null;
	kind?: SelectionRefreshClientKind;
	id?: string;
	error?: string;
};

let refreshGeneration = 0;
let clientBackoffUntil = 0;

export function getSelectionRefreshClientBackoffUntil() {
	return clientBackoffUntil;
}

export function setSelectionRefreshClientBackoffUntil(ts: number) {
	clientBackoffUntil = Math.max(0, Number(ts) || 0);
}

export function bumpSelectionRefreshGeneration() {
	refreshGeneration += 1;
	return refreshGeneration;
}

export function getSelectionRefreshGeneration() {
	return refreshGeneration;
}

export function nodeKindAndId(node: { id?: string; group?: string; crd?: string; firmId?: string } | null | undefined): {
	kind: SelectionRefreshClientKind;
	id: string;
} | null {
	if (!node) return null;
	const group = String(node.group || '').toLowerCase();
	const rawId = String(node.id || '');
	const fromId = rawId.replace(/^(person|individual|firm)[:_]/i, '').trim();
	const crd = String(node.crd || node.firmId || fromId || '').trim();
	if (!/^\d+$/.test(crd)) return null;
	if (group === 'individual' || rawId.startsWith('person:') || rawId.startsWith('individual:')) {
		return { kind: 'individual', id: crd };
	}
	if (group === 'firm' || rawId.startsWith('firm:')) {
		return { kind: 'firm', id: crd };
	}
	return null;
}

/**
 * Wait until the force sim looks calm, or until maxWaitMs — refresh-layout can
 * keep alpha hot forever, so a timeout is required.
 */
export async function waitForSelectionAnimationSettle(
	options: {
		getAlpha?: () => number;
		isSimStopped?: () => boolean;
		maxWaitMs?: number;
		pollMs?: number;
		alphaThreshold?: number;
		extraDelayMs?: number;
		isCancelled?: () => boolean;
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<'settled' | 'timeout' | 'cancelled'> {
	const getAlpha = options.getAlpha || (() => 0);
	const isSimStopped = options.isSimStopped || (() => true);
	const maxWaitMs = Math.max(250, Number(options.maxWaitMs ?? 3500));
	const pollMs = Math.max(50, Number(options.pollMs ?? 200));
	const alphaThreshold = Number(options.alphaThreshold ?? 0.05);
	const extraDelayMs = Math.max(0, Number(options.extraDelayMs ?? 200));
	const isCancelled = options.isCancelled || (() => false);
	const now = options.now || (() => Date.now());
	const sleep =
		options.sleep ||
		((ms: number) =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, ms);
			}));

	const started = now();
	while (now() - started < maxWaitMs) {
		if (isCancelled()) return 'cancelled';
		const alpha = Number(getAlpha()) || 0;
		if (isSimStopped() || alpha < alphaThreshold) {
			if (extraDelayMs) await sleep(extraDelayMs);
			return isCancelled() ? 'cancelled' : 'settled';
		}
		await sleep(pollMs);
	}
	if (isCancelled()) return 'cancelled';
	if (extraDelayMs) await sleep(extraDelayMs);
	return isCancelled() ? 'cancelled' : 'timeout';
}

export async function requestSelectionRefresh(
	kind: SelectionRefreshClientKind,
	id: string,
	fetcher: typeof fetch = fetch,
): Promise<SelectionRefreshClientResult> {
	const response = await fetcher('/api/finra/selection-refresh', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({ kind, id }),
		cache: 'no-store',
	});
	const payload = (await response.json().catch(() => null)) as SelectionRefreshClientResult | null;
	if (!payload || typeof payload !== 'object') {
		return { ok: false, error: `HTTP ${response.status}` };
	}
	return payload;
}

/**
 * Fire-and-forget: after `afterPromise` and animation settle, refresh the node.
 * Cancels if generation changes or selection no longer matches.
 */
export function scheduleSelectionExternalRefresh(options: {
	node: { id?: string; group?: string; crd?: string; firmId?: string } | null | undefined;
	afterPromise?: Promise<unknown> | null;
	getSelectedId?: () => string | null | undefined;
	getAlpha?: () => number;
	isSimStopped?: () => boolean;
	onUpdated?: (result: SelectionRefreshClientResult, nodeId: string) => void;
	fetcher?: typeof fetch;
	maxWaitMs?: number;
}): number {
	const parsed = nodeKindAndId(options.node);
	if (!parsed) return getSelectionRefreshGeneration();

	const generation = bumpSelectionRefreshGeneration();
	const selectedNodeId = String(options.node?.id || '');
	const afterPromise = options.afterPromise || Promise.resolve();

	void (async () => {
		try {
			await afterPromise.catch(() => undefined);
			if (generation !== getSelectionRefreshGeneration()) return;

			const settle = await waitForSelectionAnimationSettle({
				getAlpha: options.getAlpha,
				isSimStopped: options.isSimStopped,
				maxWaitMs: options.maxWaitMs,
				isCancelled: () => generation !== getSelectionRefreshGeneration(),
			});
			if (settle === 'cancelled') return;
			if (generation !== getSelectionRefreshGeneration()) return;

			const selectedId = options.getSelectedId?.();
			if (selectedId != null && String(selectedId) !== selectedNodeId) return;

			const now = Date.now();
			if (clientBackoffUntil > now) return;

			const result = await requestSelectionRefresh(parsed.kind, parsed.id, options.fetcher);
			if (generation !== getSelectionRefreshGeneration()) return;

			if (result.rateLimited && Number(result.resumeAt) > 0) {
				setSelectionRefreshClientBackoffUntil(Number(result.resumeAt));
				return;
			}
			if (result.skipped === 'backoff' && Number(result.resumeAt) > 0) {
				setSelectionRefreshClientBackoffUntil(Number(result.resumeAt));
				return;
			}
			// Apply whenever detail is present — including cooldown Redis hydrates and
			// unchanged external checks — so SEC/FINRA merge fixes reach the sidebar.
			if (!result.detail) return;

			const stillSelected = options.getSelectedId?.();
			if (stillSelected != null && String(stillSelected) !== selectedNodeId) return;
			options.onUpdated?.(result, selectedNodeId);
		} catch {
			/* non-critical background refresh */
		}
	})();

	return generation;
}
