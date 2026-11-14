'use client';

import { buildCanvasSnapshotFromGraph, type CanvasSnapshot } from '@/lib/localAi/canvasSnapshot';

const SESSION_LS_KEY = 'finra_session';
const SESSION_IDB_DB_NAME = 'finra_graph_session';
const SESSION_IDB_STORE_NAME = 'session_store';
const SESSION_IDB_ENTRY_KEY = 'active_session';
const SELECTION_LOG_LS_KEY = 'finra_selection_log';
const CHANNEL_NAME = 'finra-local-ai-canvas';

function readSelectionLog(): any[] {
	try {
		const raw = localStorage.getItem(SELECTION_LOG_LS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function readSessionFromLocalStorage(): any | null {
	try {
		const raw = localStorage.getItem(SESSION_LS_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (parsed?.idbPointer) return null;
		return parsed;
	} catch {
		return null;
	}
}

async function readSessionFromIndexedDb(): Promise<any | null> {
	if (typeof indexedDB === 'undefined') return null;
	return await new Promise((resolve) => {
		try {
			const req = indexedDB.open(SESSION_IDB_DB_NAME);
			req.onerror = () => resolve(null);
			req.onsuccess = () => {
				try {
					const db = req.result;
					if (!db.objectStoreNames.contains(SESSION_IDB_STORE_NAME)) {
						resolve(null);
						return;
					}
					const tx = db.transaction(SESSION_IDB_STORE_NAME, 'readonly');
					const store = tx.objectStore(SESSION_IDB_STORE_NAME);
					const getReq = store.get(SESSION_IDB_ENTRY_KEY);
					getReq.onsuccess = () => resolve(getReq.result || null);
					getReq.onerror = () => resolve(null);
				} catch {
					resolve(null);
				}
			};
		} catch {
			resolve(null);
		}
	});
}

function snapshotFromSession(session: any | null): CanvasSnapshot {
	const extraNodes = Array.isArray(session?.extraNodes) ? session.extraNodes : [];
	const positionIds = Array.isArray(session?.nodePositions) ?
		session.nodePositions.map((p: any) => ({ id: p?.id, label: String(p?.id || ''), group: String(p?.id || '').startsWith('firm:') ? 'firm' : 'individual' }))
	:	[];
	const extraNodeIdNodes = Array.isArray(session?.extraNodeIds) ?
		session.extraNodeIds.map((id: any) => ({
			id: String(id || ''),
			label: String(id || ''),
			group: String(id || '').startsWith('firm:') ? 'firm' : 'individual',
		}))
	:	[];
	const nodes =
		extraNodes.length ? extraNodes
		: positionIds.length ? positionIds
		: extraNodeIdNodes;
	const links = Array.isArray(session?.extraLinks) ? session.extraLinks : [];
	return buildCanvasSnapshotFromGraph({
		nodes,
		links,
		selectedId: session?.selectedNodeId || null,
		selectionLog: readSelectionLog(),
		source: nodes.length ? 'session' : 'empty',
		href: typeof location !== 'undefined' ? location.href : null,
	});
}

async function requestLiveSnapshot(timeoutMs = 450): Promise<CanvasSnapshot | null> {
	if (typeof BroadcastChannel === 'undefined') return null;
	const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	return await new Promise((resolve) => {
		let done = false;
		let channel: BroadcastChannel | null = null;
		const finish = (value: CanvasSnapshot | null) => {
			if (done) return;
			done = true;
			try {
				channel?.close();
			} catch {
				/* ignore */
			}
			resolve(value);
		};
		try {
			channel = new BroadcastChannel(CHANNEL_NAME);
			const timer = window.setTimeout(() => finish(null), timeoutMs);
			channel.addEventListener('message', (event: MessageEvent) => {
				const data = event?.data || {};
				if (data?.type !== 'canvas-snapshot' || String(data.requestId || '') !== requestId) return;
				window.clearTimeout(timer);
				if (data.snapshot) finish(data.snapshot as CanvasSnapshot);
				else finish(null);
			});
			channel.postMessage({ type: 'request-canvas-snapshot', requestId });
		} catch {
			finish(null);
		}
	});
}

/**
 * Prefer a live snapshot from an open graph tab; otherwise fall back to persisted session.
 */
export async function captureCanvasSnapshotForLocalAi(): Promise<CanvasSnapshot> {
	const live = await requestLiveSnapshot();
	if (live && (live.nodeCount > 0 || (live.nodes || []).length > 0)) return live;

	const idbSession = await readSessionFromIndexedDb();
	const lsSession = readSessionFromLocalStorage();
	const session = idbSession || lsSession;
	return snapshotFromSession(session);
}
