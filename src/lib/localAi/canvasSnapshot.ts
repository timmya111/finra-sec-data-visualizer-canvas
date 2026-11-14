export type CanvasSnapshotNode = {
	id: string;
	label: string;
	group: string;
	crd?: string | null;
};

export type CanvasSnapshotLink = {
	source: string;
	target: string;
	relationship?: string | null;
	isCurrent?: boolean | null;
};

export type CanvasSnapshotLogEntry = {
	id: string;
	label: string;
	group: string;
	secondaryId?: string | null;
};

export type CanvasSnapshot = {
	capturedAt: number;
	source: 'live' | 'session' | 'empty';
	href?: string | null;
	selectedId?: string | null;
	nodeCount: number;
	linkCount: number;
	personCount: number;
	firmCount: number;
	nodes: CanvasSnapshotNode[];
	links: CanvasSnapshotLink[];
	selectionLog?: CanvasSnapshotLogEntry[];
	truncated?: boolean;
	note?: string | null;
};

const MAX_SNAPSHOT_NODES = 8000;
const MAX_SNAPSHOT_LINKS = 16000;

function sid(value: unknown): string {
	if (value && typeof value === 'object' && 'id' in (value as any)) {
		return String((value as any).id || '').trim();
	}
	return String(value ?? '').trim();
}

function nodeLabel(node: any): string {
	return String(
		node?.label ||
			node?.name ||
			[node?.basicInformation?.firstName, node?.basicInformation?.middleName, node?.basicInformation?.lastName]
				.filter(Boolean)
				.join(' ') ||
			node?.id ||
			'',
	).trim();
}

function nodeGroup(node: any): string {
	const group = String(node?.group || node?.type || '').trim();
	if (group === 'firm' || group === 'individual') return group;
	const id = String(node?.id || '');
	if (id.startsWith('firm:')) return 'firm';
	if (id.startsWith('person:')) return 'individual';
	return group || 'unknown';
}

function nodeCrd(node: any): string | null {
	const id = String(node?.id || '');
	const fromId = id.includes(':') ? id.split(':').pop() : id;
	const raw = node?.crd || node?.firmId || fromId || '';
	const s = String(raw).replace(/^(person:|firm:)/i, '').trim();
	return /^\d+$/.test(s) ? s : null;
}

export function buildCanvasSnapshotFromGraph(input: {
	nodes?: any[] | null;
	links?: any[] | null;
	selectedId?: string | null;
	selectionLog?: any[] | null;
	source?: CanvasSnapshot['source'];
	href?: string | null;
}): CanvasSnapshot {
	const source = input.source || 'live';
	const allNodes = Array.isArray(input.nodes) ? input.nodes : [];
	const allLinks = Array.isArray(input.links) ? input.links : [];
	const truncated = allNodes.length > MAX_SNAPSHOT_NODES || allLinks.length > MAX_SNAPSHOT_LINKS;
	const nodes = allNodes.slice(0, MAX_SNAPSHOT_NODES).map((node) => {
		const id = String(node?.id || '').trim();
		return {
			id,
			label: nodeLabel(node) || id,
			group: nodeGroup(node),
			crd: nodeCrd(node),
		};
	});
	const links = allLinks.slice(0, MAX_SNAPSHOT_LINKS).map((link) => ({
		source: sid(link?.source),
		target: sid(link?.target),
		relationship: link?.relationship != null ? String(link.relationship) : null,
		isCurrent: typeof link?.isCurrent === 'boolean' ? link.isCurrent : null,
	}));
	const personCount = nodes.filter((n) => n.group === 'individual' || n.id.startsWith('person:')).length;
	const firmCount = nodes.filter((n) => n.group === 'firm' || n.id.startsWith('firm:')).length;
	const selectionLog = Array.isArray(input.selectionLog) ?
		input.selectionLog
			.map((entry) => ({
				id: String(entry?.id || '').trim(),
				label: String(entry?.label || entry?.id || '').trim(),
				group: String(entry?.group || '').trim(),
				secondaryId: entry?.secondaryId != null ? String(entry.secondaryId) : null,
			}))
			.filter((entry) => entry.id)
	:	[];

	return {
		capturedAt: Date.now(),
		source: allNodes.length ? source : 'empty',
		href: input.href || null,
		selectedId: input.selectedId ? String(input.selectedId) : null,
		nodeCount: allNodes.length,
		linkCount: allLinks.length,
		personCount,
		firmCount,
		nodes,
		links,
		selectionLog,
		truncated,
		note:
			truncated ?
				`Snapshot truncated to ${MAX_SNAPSHOT_NODES} nodes / ${MAX_SNAPSHOT_LINKS} links`
			:	null,
	};
}

function formatPersonLine(node: CanvasSnapshotNode): string {
	const crd = node.crd || node.id.replace(/^person:/, '');
	return `${node.label || crd} :: CRD# ${crd}`;
}

export function inspectCanvasSnapshot(
	snapshot: CanvasSnapshot | null | undefined,
	args: Record<string, unknown> = {},
): { ok: boolean; result: unknown } {
	if (!snapshot || !Array.isArray(snapshot.nodes)) {
		return {
			ok: false,
			result: {
				error: 'No canvas snapshot available. Open the graph tab, or restore a session, then ask again.',
			},
		};
	}

	const action = String(args.action || 'summary')
		.trim()
		.toLowerCase();
	const query = String(args.query || '')
		.trim()
		.toLowerCase();
	const limit = Math.max(1, Math.min(200, Number(args.limit) || 40));
	const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));

	if (action === 'summary') {
		return {
			ok: true,
			result: {
				source: snapshot.source,
				href: snapshot.href,
				capturedAt: snapshot.capturedAt,
				nodeCount: snapshot.nodeCount,
				linkCount: snapshot.linkCount,
				personCount: snapshot.personCount,
				firmCount: snapshot.firmCount,
				selectedId: snapshot.selectedId,
				selectionLogCount: snapshot.selectionLog?.length || 0,
				truncated: Boolean(snapshot.truncated),
				note: snapshot.note,
				samplePeople: snapshot.nodes
					.filter((n) => n.group === 'individual' || n.id.startsWith('person:'))
					.slice(0, 8)
					.map(formatPersonLine),
				sampleFirms: snapshot.nodes
					.filter((n) => n.group === 'firm' || n.id.startsWith('firm:'))
					.slice(0, 8)
					.map((n) => `${n.label} :: CRD# ${n.crd || n.id.replace(/^firm:/, '')}`),
			},
		};
	}

	if (action === 'list_people' || action === 'list_firms') {
		const wantFirm = action === 'list_firms';
		let rows = snapshot.nodes.filter((n) =>
			wantFirm ? n.group === 'firm' || n.id.startsWith('firm:') : n.group === 'individual' || n.id.startsWith('person:'),
		);
		if (query) {
			rows = rows.filter(
				(n) =>
					n.label.toLowerCase().includes(query) ||
					n.id.toLowerCase().includes(query) ||
					String(n.crd || '').includes(query),
			);
		}
		rows = rows.sort((a, b) => a.label.localeCompare(b.label)).slice(0, limit);
		return {
			ok: true,
			result: {
				action,
				totalMatching: rows.length,
				items: rows.map((n) =>
					wantFirm ? `${n.label} :: CRD# ${n.crd || n.id.replace(/^firm:/, '')}` : formatPersonLine(n),
				),
			},
		};
	}

	if (action === 'selection_log') {
		const items = (snapshot.selectionLog || []).slice(0, limit).map((e) => {
			const crd = e.id.includes(':') ? e.id.split(':').pop() : e.id;
			return `${e.label} :: CRD# ${crd}`;
		});
		return {
			ok: true,
			result: {
				count: snapshot.selectionLog?.length || 0,
				returned: items.length,
				items,
			},
		};
	}

	if (action === 'neighbors') {
		const nodeId = String(args.nodeId || '').trim();
		if (!nodeId || !byId.has(nodeId)) {
			return { ok: false, result: { error: 'nodeId required and must exist on canvas', nodeId } };
		}
		const neighborIds = new Set<string>();
		for (const link of snapshot.links) {
			if (link.source === nodeId) neighborIds.add(link.target);
			if (link.target === nodeId) neighborIds.add(link.source);
		}
		const neighbors = [...neighborIds]
			.map((id) => byId.get(id))
			.filter(Boolean)
			.slice(0, limit) as CanvasSnapshotNode[];
		return {
			ok: true,
			result: {
				node: byId.get(nodeId),
				neighborCount: neighborIds.size,
				neighbors: neighbors.map((n) =>
					n.group === 'firm' || n.id.startsWith('firm:') ?
						`${n.label} :: CRD# ${n.crd || n.id.replace(/^firm:/, '')}`
					:	formatPersonLine(n),
				),
			},
		};
	}

	if (action === 'dual_on_canvas') {
		const firmLinksByPerson = new Map<string, Set<string>>();
		for (const link of snapshot.links) {
			const a = link.source;
			const b = link.target;
			let personId: string | null = null;
			let firmId: string | null = null;
			if (a.startsWith('person:') && b.startsWith('firm:')) {
				personId = a;
				firmId = b;
			} else if (b.startsWith('person:') && a.startsWith('firm:')) {
				personId = b;
				firmId = a;
			} else continue;
			if (!firmLinksByPerson.has(personId)) firmLinksByPerson.set(personId, new Set());
			firmLinksByPerson.get(personId)!.add(firmId);
		}
		const rows: Array<{ line: string; firmCount: number; firms: string[] }> = [];
		for (const [personId, firms] of firmLinksByPerson) {
			if (firms.size < 2) continue;
			const person = byId.get(personId);
			rows.push({
				line: formatPersonLine(person || { id: personId, label: personId, group: 'individual' }),
				firmCount: firms.size,
				firms: [...firms]
					.map((fid) => {
						const firm = byId.get(fid);
						return firm ? `${firm.label} (${firm.crd || fid.replace(/^firm:/, '')})` : fid;
					})
					.sort(),
			});
		}
		rows.sort((a, b) => b.firmCount - a.firmCount || a.line.localeCompare(b.line));
		const sliced = rows.slice(0, limit);
		return {
			ok: true,
			result: {
				note: 'Based on person↔firm links currently drawn on the canvas (not full BrokerCheck current roster).',
				totalMatches: rows.length,
				returned: sliced.length,
				people: sliced,
			},
		};
	}

	if (action === 'search') {
		if (!query) return { ok: false, result: { error: 'query required for search' } };
		const hits = snapshot.nodes
			.filter(
				(n) =>
					n.label.toLowerCase().includes(query) ||
					n.id.toLowerCase().includes(query) ||
					String(n.crd || '').includes(query),
			)
			.slice(0, limit)
			.map((n) => ({
				id: n.id,
				line:
					n.group === 'firm' || n.id.startsWith('firm:') ?
						`${n.label} :: CRD# ${n.crd || n.id.replace(/^firm:/, '')}`
					:	formatPersonLine(n),
				group: n.group,
			}));
		return { ok: true, result: { query, returned: hits.length, hits } };
	}

	return {
		ok: false,
		result: {
			error: `unknown action: ${action}`,
			supported: ['summary', 'list_people', 'list_firms', 'selection_log', 'neighbors', 'dual_on_canvas', 'search'],
		},
	};
}
