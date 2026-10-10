<script lang="ts">
	import LivePanel from './LivePanel.svelte';
	let on = $state(false);
</script>

<button data-testid="start" onclick={() => (on = true)}>Start</button>
{#if on}<LivePanel />{/if}
