<script lang="ts">
	import { onMount } from 'svelte';
	import { items } from '../stores';
	const { list, title, error } = items;
	onMount(() => void items.load());
</script>

<h2>Items</h2>
<form
	onsubmit={(e) => {
		e.preventDefault();
		void items.create();
	}}
>
	<input data-testid="title" bind:value={$title} placeholder="New item" />
	<button data-testid="create" type="submit">Create</button>
</form>
<ul>
	{#each $list ?? [] as i (i.id)}
		<li data-testid="item">{i.title}</li>
	{/each}
</ul>
{#if $error}<p data-testid="error">{$error}</p>{/if}
