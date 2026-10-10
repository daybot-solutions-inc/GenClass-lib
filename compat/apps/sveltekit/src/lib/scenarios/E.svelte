<script lang="ts">
	import { onMount } from 'svelte';
	import { notes } from '../stores';
	const { list, draft } = notes;
	onMount(() => notes.start());
</script>

<h2>Notes</h2>
<input data-testid="note-text" bind:value={$draft} placeholder="Note" />
<button data-testid="note-add" onclick={() => notes.add()}>Add</button>
<ul>
	{#each $list ?? [] as n (n.key)}
		<li data-testid="note">{n.text}{n.pending ? ' (pending)' : ''}</li>
	{/each}
</ul>
