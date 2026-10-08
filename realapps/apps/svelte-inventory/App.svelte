<script lang="ts">
  import { onMount } from "svelte";
  import { inv, receiving, start, stop, adjust, receive, setQuery, isLow, RECEIVE_LOCK } from "./inventory";

  let show = $state("all");
  const rows = $derived(show === "low" ? $inv.items.filter(isLow) : show === "ok" ? $inv.items.filter((it) => !isLow(it)) : $inv.items);

  onMount(() => {
    start();
    return stop;
  });
</script>

<div class="inventory">
  <header>
    <h1>Stockroom</h1>
    <p class="low-count">{$inv.lowCount} {$inv.lowCount === 1 ? "item" : "items"} at or below reorder level</p>
  </header>
  <div class="filters">
    <label>Search <input name="q" value={$inv.q} oninput={(e) => setQuery(e.currentTarget.value)} placeholder="SKU or name" /></label>
    <label>Show
      <select name="show" bind:value={show}>
        <option value="all">All items</option>
        <option value="low">Needs reorder</option>
        <option value="ok">In stock</option>
      </select>
    </label>
    {#if $inv.loading}<span class="loading">Loading…</span>{/if}
  </div>
  {#if $inv.error}<p role="alert">{$inv.error}</p>{/if}
  <table>
    <thead><tr><th>SKU</th><th>Item</th><th>Bin</th><th>On hand</th><th></th><th></th></tr></thead>
    <tbody>
      {#each rows as it (it.id)}
        <tr class="item" class:low={isLow(it)}>
          <td>{it.sku}</td>
          <td>{it.name}</td>
          <td>{it.bin}</td>
          <td>
            <button class="dec" aria-label="Remove one" onclick={() => adjust(it.id, -1)}>−</button>
            <span class="stock">{it.stock}</span>
            <button class="inc" aria-label="Add one" onclick={() => adjust(it.id, 1)}>+</button>
          </td>
          <td><button class="receive" disabled={RECEIVE_LOCK && $receiving.includes(it.id)} onclick={() => receive(it.id)}>Receive case</button></td>
          <td>{#if isLow(it)}<span class="badge-low">Reorder (min {it.min})</span>{/if}</td>
        </tr>
      {:else}
        <tr><td colspan="6">No items match.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
