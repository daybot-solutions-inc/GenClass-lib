<script lang="ts">
	import { onMount } from 'svelte';
	import { DETAIL_IDS } from '../api';
	import { live } from '../stores';
	const { tick, polls, details } = live;
	onMount(() => live.start());
</script>

<div>
	<p>Tick <span data-testid="tick">{$tick}</span> after <span data-testid="polls">{$polls}</span> polls</p>
	<ul>
		{#each DETAIL_IDS as id (id)}
			{#if $details[id]}
				<li data-testid="detail">{$details[id].name}: {$details[id].price}</li>
			{:else}
				<li>loading</li>
			{/if}
		{/each}
	</ul>
</div>
