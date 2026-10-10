// Svelte stores (svelte/store writables) and the actions that fill them, one group per scenario, written the common
// way: the search action sets whatever answer arrives (a: no ordering guard), the create action has no in-flight
// guard (b). The other scenarios are correct. Everything that touches the network or `window` runs in the browser
// only (onMount / event handlers): this module is also evaluated during SSR. GenClass does not discover Svelte
// stores (README: not covered yet); it sees the network and user input.
import { get, writable } from 'svelte/store';
import * as api from './api';

export type NoteRow = { key: string; text: string; pending?: boolean };

export const search = (() => {
	const q = writable('');
	const results = writable<string[]>([]);
	function setQ(v: string) {
		q.set(v);
		if (!v) return results.set([]);
		api.search(v).then((r) => results.set(r.results), () => {});
	}
	return { q, results, setQ };
})();

export const items = (() => {
	const list = writable<api.Item[] | null>(null);
	const title = writable('');
	const error = writable<string | null>(null);
	const load = () => api.items().then((r) => list.set(r.items));
	async function create() {
		try {
			const item = await api.createItem(get(title));
			list.update((xs) => [...(xs ?? []), item]);
			title.set('');
		} catch {
			error.set('Could not create');
		}
	}
	return { list, title, error, load, create };
})();

export const panels = (() => {
	const left = writable<string[] | null>(null);
	const right = writable<string[] | null>(null);
	function load() {
		api.left().then((p) => left.set(p.rows));
		api.right().then((p) => right.set(p.rows));
	}
	return { left, right, load };
})();

export const todos = (() => {
	const list = writable<api.Todo[] | null>(null);
	const error = writable<string | null>(null);
	const load = () => api.todos().then((r) => list.set(r.todos));
	const patch = (id: number, fn: (x: api.Todo) => api.Todo) => list.update((ts) => ts!.map((x) => (x.id === id ? fn(x) : x)));
	async function toggle(t: api.Todo) {
		const done = !t.done;
		patch(t.id, (x) => ({ ...x, done })); // optimistic
		try {
			const saved = await api.toggleTodo(t.id, done);
			patch(t.id, () => saved);
		} catch {
			patch(t.id, (x) => ({ ...x, done: t.done })); // roll back
			error.set(`Could not save "${t.title}"`);
		}
	}
	return { list, error, load, toggle };
})();

let noteSeq = 0;
export const notes = (() => {
	const list = writable<NoteRow[] | null>(null);
	const draft = writable('');
	let outbox: api.Outbox<NoteRow> | null = null;
	/** Browser only (onMount): loads the list and starts the offline outbox. */
	function start() {
		api.notes().then((r) => list.set(r.notes.map((n) => ({ key: `s${n.id}`, text: n.text }))));
		outbox = api.createOutbox<NoteRow>(async (row) => {
			try {
				const saved = await api.addNote(row.text);
				list.update((ns) => ns!.map((n) => (n.key === row.key ? { key: `s${saved.id}`, text: saved.text } : n)));
				return true;
			} catch {
				return false;
			}
		});
		return () => outbox?.dispose();
	}
	function add() {
		const row = { key: `l${++noteSeq}`, text: get(draft), pending: true };
		draft.set('');
		list.update((ns) => [...(ns ?? []), row]);
		void outbox?.submit(row);
	}
	return { list, draft, start, add };
})();

export const counter = (() => {
	const count = writable(0);
	const synced = writable(0);
	function plus() {
		count.update((c) => c + 1);
		api.increment().then((r) => synced.update((s) => Math.max(s, r.count)));
	}
	return { count, synced, plus };
})();

export const live = (() => {
	const tick = writable(0);
	const polls = writable(0);
	const details = writable<Record<number, api.Detail>>({});
	function start() {
		for (const id of api.DETAIL_IDS) api.detail(id).then((d) => details.update((m) => ({ ...m, [id]: d })));
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			const r = await api.status();
			if (stopped) return;
			tick.set(r.tick);
			polls.update((p) => p + 1);
			if (r.tick < 8) timer = setTimeout(poll, 250);
		};
		void poll();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}
	return { tick, polls, details, start };
})();
