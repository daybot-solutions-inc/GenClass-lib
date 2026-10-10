<script lang="ts">
	import { search } from '../stores';
	const { q, results } = search;
</script>

<h2>City search</h2>
<input data-testid="q" value={$q} oninput={(e) => search.setQ(e.currentTarget.value)} placeholder="Search cities" autocomplete="off" />
<ul>
	{#each $results as r (r)}
		<li data-testid="result">{r}</li>
	{/each}
</ul>
