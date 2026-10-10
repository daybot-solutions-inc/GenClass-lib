<script lang="ts">
	// A search box written the way a lot of code is: every keystroke fetches, and whichever answer arrives last wins.
	// The API route answers in a random 50-900 ms, so type quickly and an older answer can overwrite a newer one.
	// GenClass watches this with no code here: open the overlay (bottom right, development only) to see what it finds.
	let q = $state('');
	let results = $state<string[]>([]);

	function search(v: string) {
		q = v;
		if (!v) return void (results = []);
		fetch(`/api/search?q=${encodeURIComponent(v)}`)
			.then((r) => r.json())
			.then((r: { results: string[] }) => (results = r.results));
	}
</script>

<svelte:head><title>GenClass + SvelteKit</title></svelte:head>

<main style="font-family: system-ui, sans-serif; max-width: 520px; margin: 48px auto; padding: 0 16px">
	<h1>GenClass + SvelteKit</h1>
	<p>Type a city quickly, for example “san”, then look at the GenClass overlay.</p>
	<input value={q} oninput={(e) => search(e.currentTarget.value)} placeholder="Search cities" style="width: 100%; padding: 8px; font-size: 16px" />
	<ul>
		{#each results as r (r)}
			<li>{r}</li>
		{/each}
	</ul>
</main>
