// SSR safety probe (compat runner): what importing GenClass's one line does on the server. Expected: an inert
// runtime, the server's fetch untouched, no devtools globals added to the Node process.
import { json } from '@sveltejs/kit';

const HOOKS = ['__REACT_DEVTOOLS_GLOBAL_HOOK__', '__REDUX_DEVTOOLS_EXTENSION__', '__REDUX_DEVTOOLS_EXTENSION_COMPOSE__'];

export async function GET() {
	const g = globalThis as Record<string, unknown>;
	const fetchBefore = g.fetch;
	const before = HOOKS.filter((k) => k in g);
	try {
		const rt = (await import('@genclass/runtime/auto')).default;
		return json({
			fetchSame: g.fetch === fetchBefore,
			state: rt.status.state,
			mode: rt.mode,
			stores: rt.stores().length,
			globalsAdded: HOOKS.filter((k) => k in g && !before.includes(k)),
			error: null
		});
	} catch (e) {
		return json({ error: String((e as Error)?.stack ?? e) });
	}
}
