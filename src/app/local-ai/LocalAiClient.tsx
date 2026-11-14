'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import LocalOnlyCornerLink from '@/components/LocalOnlyCornerLink';
import { captureCanvasSnapshotForLocalAi } from '@/lib/localAi/captureCanvasSnapshotClient';
import type { CanvasSnapshot } from '@/lib/localAi/canvasSnapshot';

type ChatTurn = { role: 'user' | 'assistant'; content: string };

type StatusPayload = {
	ok: boolean;
	baseUrl?: string;
	defaultModel?: string;
	models?: string[];
	error?: string | null;
};

const EXAMPLES = [
	'Summarize the nodes currently on my canvas.',
	'Which people on the canvas connect to two different firms?',
	'List people currently at 2+ firms in BrokerCheck data. Return Name :: CRD# lines.',
	'Show the employment timeline for CRD 5417517 including begin/end dates.',
];

export default function LocalAiClient() {
	const [status, setStatus] = useState<StatusPayload | null>(null);
	const [model, setModel] = useState('qwen2.5:7b');
	const [question, setQuestion] = useState('');
	const [history, setHistory] = useState<ChatTurn[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [toolTrace, setToolTrace] = useState<any[] | null>(null);
	const [canvasInfo, setCanvasInfo] = useState<string>('Checking canvas…');
	const [aboutNodeGraph, setAboutNodeGraph] = useState(false);

	const preferredModels = useMemo(() => {
		const models = status?.models || [];
		const prefer = ['qwen2.5:7b', 'qwen2.5:14b', 'qwen3.6:latest', 'llama3.2:latest'];
		const ordered = [...prefer.filter((m) => models.includes(m)), ...models.filter((m) => !prefer.includes(m))];
		return ordered.length ? ordered : prefer;
	}, [status]);

	const refreshCanvasInfo = useCallback(async () => {
		try {
			const snap = await captureCanvasSnapshotForLocalAi();
			if (!snap || snap.nodeCount <= 0) {
				setCanvasInfo('Canvas: none (keep the graph tab open, or restore a session)');
				return snap;
			}
			setCanvasInfo(
				`Canvas: ${snap.nodeCount} nodes / ${snap.linkCount} links (${snap.source}${snap.truncated ? ', truncated' : ''})`,
			);
			return snap;
		} catch {
			setCanvasInfo('Canvas: unavailable');
			return null;
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch('/api/local-ai/status', { cache: 'no-store' });
				const data = (await res.json()) as StatusPayload;
				if (cancelled) return;
				setStatus(data);
				if (data.defaultModel) setModel(data.defaultModel);
				else if (data.models?.includes('qwen2.5:7b')) setModel('qwen2.5:7b');
			} catch (e: any) {
				if (!cancelled) setStatus({ ok: false, error: e?.message || String(e) });
			}
			if (!cancelled) await refreshCanvasInfo();
		})();
		return () => {
			cancelled = true;
		};
	}, [refreshCanvasInfo]);

	const ask = useCallback(async () => {
		const q = question.trim();
		if (!q || busy) return;
		setBusy(true);
		setError(null);
		setToolTrace(null);
		setHistory((prev) => [...prev, { role: 'user', content: q }]);
		setQuestion('');
		try {
			const canvasSnapshot: CanvasSnapshot | null = aboutNodeGraph ? await refreshCanvasInfo() : null;
			if (!aboutNodeGraph) void refreshCanvasInfo();
			const res = await fetch('/api/local-ai/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					question: q,
					model,
					history: history.slice(-8),
					aboutNodeGraph,
					canvasSnapshot,
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) {
				throw new Error(data?.error || `chat failed (${res.status})`);
			}
			setHistory((prev) => [...prev, { role: 'assistant', content: String(data.answer || '') }]);
			setToolTrace(Array.isArray(data.toolTrace) ? data.toolTrace : []);
		} catch (e: any) {
			setError(e?.message || String(e));
			setHistory((prev) => [...prev, { role: 'assistant', content: `Error: ${e?.message || String(e)}` }]);
		} finally {
			setBusy(false);
		}
	}, [aboutNodeGraph, busy, history, model, question, refreshCanvasInfo]);

	return (
		<main
			style={{
				fontFamily: 'var(--font-urbanist), system-ui, sans-serif',
				maxWidth: 920,
				margin: '0 auto',
				padding: '20px 16px 48px',
				color: 'var(--text, #111)',
			}}>
			<header style={{ marginBottom: 16 }}>
				<p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>local only · Ollama</p>
				<h1 style={{ margin: '6px 0 8px', fontSize: 28 }}>Local AI</h1>
				<p style={{ margin: 0, opacity: 0.8, lineHeight: 1.45 }}>
					Ask about current dual-firm people, firm rosters, and employment timelines. The model calls local
					tools over your firm-connections / individual data.
				</p>
			</header>

			<label
				style={{
					display: 'flex',
					gap: 10,
					alignItems: 'center',
					marginBottom: 16,
					padding: '10px 12px',
					border: '1px solid var(--border-strong, #ccc)',
					borderRadius: 8,
					background: aboutNodeGraph ? 'rgba(249, 115, 22, 0.10)' : 'var(--surface, #fafafa)',
					cursor: 'pointer',
					userSelect: 'none',
					fontSize: 14,
					fontWeight: 600,
				}}>
				<input
					type="checkbox"
					checked={aboutNodeGraph}
					onChange={(e) => setAboutNodeGraph(e.target.checked)}
					disabled={busy}
					style={{ width: 16, height: 16 }}
				/>
				<span>Question about node graph</span>
				<span style={{ fontWeight: 400, opacity: 0.7, fontSize: 12 }}>
					{aboutNodeGraph ? 'Attaches live/session canvas · uses inspect_canvas_graph' : 'Off · roster/Redis tools only'}
				</span>
			</label>

			<section
				style={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: 12,
					alignItems: 'center',
					marginBottom: 16,
					padding: 12,
					border: '1px solid var(--border-strong, #ccc)',
					borderRadius: 8,
					background: 'var(--surface, #fafafa)',
				}}>
				<label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
					<span style={{ fontSize: 13, opacity: 0.8 }}>Model</span>
					<select
						value={model}
						onChange={(e) => setModel(e.target.value)}
						disabled={busy}
						style={{ padding: '6px 8px', borderRadius: 6, minWidth: 180 }}>
						{preferredModels.map((m) => (
							<option key={m} value={m}>
								{m}
							</option>
						))}
					</select>
				</label>
				<span style={{ fontSize: 13, opacity: 0.75 }}>
					{status == null ? 'Checking Ollama…'
					: status.ok ? `Ollama ok · ${status.models?.length || 0} models`
					:	`Ollama unreachable: ${status.error || 'unknown error'}`}
				</span>
				<span style={{ fontSize: 13, opacity: 0.75 }}>{canvasInfo}</span>
				<button
					type="button"
					onClick={() => void refreshCanvasInfo()}
					disabled={busy}
					style={{
						fontSize: 12,
						padding: '4px 8px',
						borderRadius: 6,
						border: '1px solid var(--border-strong, #ccc)',
						background: 'transparent',
						cursor: 'pointer',
					}}>
					Refresh canvas
				</button>
			</section>

			<section style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
				{EXAMPLES.map((example) => (
					<button
						key={example}
						type="button"
						disabled={busy}
						onClick={() => setQuestion(example)}
						style={{
							fontSize: 12,
							padding: '6px 10px',
							borderRadius: 999,
							border: '1px solid var(--border-strong, #ccc)',
							background: 'transparent',
							cursor: 'pointer',
							maxWidth: '100%',
							textAlign: 'left',
						}}>
						{example}
					</button>
				))}
			</section>

			<section
				style={{
					display: 'flex',
					flexDirection: 'column',
					gap: 12,
					minHeight: 280,
					marginBottom: 12,
					padding: 12,
					border: '1px solid var(--border-strong, #ccc)',
					borderRadius: 8,
					background: 'var(--bg, #fff)',
				}}>
				{history.length === 0 ?
					<p style={{ opacity: 0.6, margin: 0 }}>No messages yet. Try an example above.</p>
				:	history.map((turn, index) => (
						<div
							key={`${turn.role}-${index}`}
							style={{
								alignSelf: turn.role === 'user' ? 'flex-end' : 'flex-start',
								maxWidth: '92%',
								padding: '10px 12px',
								borderRadius: 10,
								whiteSpace: 'pre-wrap',
								lineHeight: 1.45,
								background: turn.role === 'user' ? 'rgba(249, 115, 22, 0.12)' : 'rgba(0,0,0,0.04)',
							}}>
							<div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>
								{turn.role === 'user' ? 'You' : 'Assistant'}
							</div>
							{turn.content}
						</div>
					))
				}
			</section>

			<form
				onSubmit={(e) => {
					e.preventDefault();
					void ask();
				}}
				style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
				<textarea
					value={question}
					onChange={(e) => setQuestion(e.target.value)}
					placeholder="Ask about current dual CRDs, firm bridges, timelines…"
					rows={3}
					disabled={busy}
					style={{
						flex: 1,
						padding: 10,
						borderRadius: 8,
						border: '1px solid var(--border-strong, #ccc)',
						resize: 'vertical',
						font: 'inherit',
					}}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							void ask();
						}
					}}
				/>
				<button
					type="submit"
					disabled={busy || !question.trim()}
					style={{
						padding: '10px 14px',
						borderRadius: 8,
						border: 'none',
						background: '#F97316',
						color: '#fff',
						fontWeight: 600,
						cursor: busy ? 'wait' : 'pointer',
						minWidth: 88,
					}}>
					{busy ? 'Working…' : 'Ask'}
				</button>
			</form>

			{error ?
				<p style={{ color: '#b91c1c', marginTop: 10 }}>{error}</p>
			:	null}

			{toolTrace && toolTrace.length > 0 ?
				<details style={{ marginTop: 16 }}>
					<summary style={{ cursor: 'pointer' }}>Tool trace ({toolTrace.length})</summary>
					<pre
						style={{
							overflow: 'auto',
							padding: 12,
							borderRadius: 8,
							background: 'rgba(0,0,0,0.04)',
							fontSize: 12,
							lineHeight: 1.4,
						}}>
						{JSON.stringify(toolTrace, null, 2)}
					</pre>
				</details>
			:	null}

			<LocalOnlyCornerLink
				href="/"
				label="Graph"
				title="Back to graph"
			/>
		</main>
	);
}
