<script lang="ts">
	import { onMount } from 'svelte';
	import { items, search } from '../stores';
	const { list, title } = items;
	const { q, results } = search;
	onMount(() => void items.load());
</script>

<h2>Items</h2>
<ul>
	{#each $list ?? [] as i (i.id)}
		<li data-testid="item">{i.title}</li>
	{/each}
</ul>
<form
	onsubmit={(e) => {
		e.preventDefault();
		void items.create();
	}}
>
	<input data-testid="title" bind:value={$title} placeholder="New item" />
	<button data-testid="create" type="submit">Create</button>
</form>
<h2>Search</h2>
<input data-testid="q" value={$q} oninput={(e) => search.setQ(e.currentTarget.value)} placeholder="Search cities" autocomplete="off" />
<ul>
	{#each $results as r (r)}
		<li data-testid="result">{r}</li>
	{/each}
</ul>
