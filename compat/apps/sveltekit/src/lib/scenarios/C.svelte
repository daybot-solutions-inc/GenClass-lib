<script lang="ts">
	import { panels } from '../stores';
	const { left, right } = panels;
</script>

<button data-testid="load" onclick={() => panels.load()}>Load both</button>
<section>
	<h3>People</h3>
	<ul>
		{#each $left ?? [] as r (r)}<li data-testid="left-row">{r}</li>{/each}
	</ul>
</section>
<section>
	<h3>Activity</h3>
	<ul>
		{#each $right ?? [] as r (r)}<li data-testid="right-row">{r}</li>{/each}
	</ul>
</section>
