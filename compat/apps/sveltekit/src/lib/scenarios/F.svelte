<script lang="ts">
	import { counter } from '../stores';
	const { count, synced } = counter;
</script>

<button data-testid="plus" onclick={() => counter.plus()}>+1</button>
<p>Count <span data-testid="count">{$count}</span>, saved <span data-testid="synced">{$synced}</span></p>
