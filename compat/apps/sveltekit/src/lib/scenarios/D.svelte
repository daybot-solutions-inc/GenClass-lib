<script lang="ts">
	import { onMount } from 'svelte';
	import { todos } from '../stores';
	const { list, error } = todos;
	onMount(() => void todos.load());
</script>

<h2>Todos</h2>
<ul>
	{#each $list ?? [] as t (t.id)}
		<li data-testid="todo">
			<label>
				<input type="checkbox" data-testid={`toggle-${t.id}`} checked={t.done} onchange={() => void todos.toggle(t)} />
				{t.title}: {t.done ? 'done' : 'open'}
			</label>
		</li>
	{/each}
</ul>
{#if $error}<p data-testid="error">{$error}</p>{/if}
