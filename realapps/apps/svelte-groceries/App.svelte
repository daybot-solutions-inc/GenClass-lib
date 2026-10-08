<script lang="ts">
  import { onMount } from "svelte";
  import { groceries, start, tick, more, add, clearChecked, setDraft, type Item } from "./groceries";

  const byAisle = $derived(
    $groceries.items.reduce((acc: Record<string, Item[]>, i: Item) => ((acc[i.aisle] ??= []).push(i), acc), {} as Record<string, Item[]>),
  );
  onMount(() => start());
</script>

<main class="groceries">
  <h1>Groceries</h1>
  <p class="left">{$groceries.left} left to buy · {$groceries.live ? "live" : "reconnecting…"}</p>
  {#if $groceries.error}<p role="alert">{$groceries.error}</p>{:else if $groceries.notice}<p class="notice">{$groceries.notice}</p>{/if}
  {#each Object.entries(byAisle) as [aisle, items] (aisle)}
    <h2>{aisle}</h2>
    <ul class="aisle">
      {#each items as it, i (String(it.id) + "-" + i)}
        <li class="item" class:checked={it.checked}>
          <input type="checkbox" class="done" checked={it.checked} disabled={it.pending || $groceries.pending.includes(it.id)} onclick={() => void tick(it)} />
          {it.name} × {it.qty} · {it.addedBy}{it.pending ? " (adding…)" : ""}
          <button type="button" class="more" disabled={it.pending} onclick={() => void more(it)}>+1</button>
        </li>
      {/each}
    </ul>
  {/each}
  <form class="add" onsubmit={(e) => { e.preventDefault(); void add(); }}>
    <input name="item" placeholder="Add an item" value={$groceries.draft} oninput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)} />
    <button type="submit">Add</button>
  </form>
  <button type="button" class="clear-checked" disabled={$groceries.clearing || !$groceries.items.some((i) => i.checked)} onclick={() => void clearChecked()}>Clear ticked items</button>
</main>
