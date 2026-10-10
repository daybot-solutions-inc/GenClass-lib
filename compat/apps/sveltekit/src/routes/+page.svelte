<script lang="ts">
	// The compat page: ?s=<scenario a-h>, server-rendered, then hydrated. Data loads in the browser (onMount).
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import A from '../lib/scenarios/A.svelte';
	import B from '../lib/scenarios/B.svelte';
	import C from '../lib/scenarios/C.svelte';
	import D from '../lib/scenarios/D.svelte';
	import E from '../lib/scenarios/E.svelte';
	import F from '../lib/scenarios/F.svelte';
	import G from '../lib/scenarios/G.svelte';
	import H from '../lib/scenarios/H.svelte';

	const S = { a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H } as const;
	const Scenario = $derived(S[(page.url.searchParams.get('s') ?? 'h') as keyof typeof S] ?? H);
	let mounted = $state(false);
	onMount(() => (mounted = true));
</script>

<div id="compat" data-ssr="1" data-ready={mounted ? '1' : '0'}>
	<Scenario />
</div>
