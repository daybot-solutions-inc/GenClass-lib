<script lang="ts">
  import { list, ui, statusEdit, priorityEdit, createOrder, removeOrder, takeDraft, setDraft, setLocation, setTab, clearError, nextPriority, LOCATIONS, CREATE_LOCK, type WorkOrder, type Status } from "./orders";

  const items = $derived(($list.data?.items ?? []) as WorkOrder[]);
  const shown = $derived($ui.tab === "active" ? items.filter((o) => o.status !== "done") : $ui.tab === "all" ? items : items.filter((o) => o.status === $ui.tab));
  const count = (s: Status) => items.filter((o) => o.status === s).length;

  function changeStatus(o: WorkOrder, value: string) {
    clearError();
    $statusEdit.mutate({ id: o.id, value: value as Status });
  }
  function escalate(o: WorkOrder) {
    clearError();
    $priorityEdit.mutate({ id: o.id, value: nextPriority(o.priority) });
  }
  function submit() {
    const v = takeDraft($createOrder.isPending);
    if (v) $createOrder.mutate(v);
  }
  function remove(o: WorkOrder) {
    clearError();
    $removeOrder.mutate({ id: o.id });
  }
</script>

<main class="workorders">
  <header>
    <h1>Facilities work orders</h1>
    <p class="summary">{count("open")} open · {count("in-progress")} in progress · {count("done")} done{#if $list.isFetching} · refreshing…{/if}</p>
  </header>
  <form class="new" onsubmit={(e) => { e.preventDefault(); submit(); }}>
    <input name="title" placeholder="What needs fixing?" value={$ui.draft} oninput={(e) => setDraft(e.currentTarget.value)} />
    <select name="location" aria-label="Location" value={$ui.location} onchange={(e) => setLocation(e.currentTarget.value)}>
      {#each LOCATIONS as l}<option value={l}>{l}</option>{/each}
    </select>
    <button class="log" type="submit" disabled={CREATE_LOCK && $createOrder.isPending}>{$createOrder.isPending ? "Logging…" : "Log work order"}</button>
  </form>
  <label class="tab">Show
    <select name="tab" aria-label="Show" value={$ui.tab} onchange={(e) => setTab(e.currentTarget.value)}>
      <option value="active">Open and in progress</option>
      <option value="open">Open</option>
      <option value="in-progress">In progress</option>
      <option value="done">Done</option>
      <option value="all">Everything</option>
    </select>
  </label>
  {#if $ui.error}<p role="alert">{$ui.error}</p>{/if}
  {#if $list.isError && !$list.data}<p role="alert">Work orders couldn't be loaded.</p>{/if}
  {#if $list.isPending}<p>Loading work orders…</p>{/if}
  <ul>
    {#each shown as o (o.id)}
      <li class="wo" class:urgent={o.priority === "urgent"}>
        <span class="title">{o.title}</span> · {o.location} · {o.priority} · {o.assignee}
        <select class="status" aria-label="Status" value={o.status} onchange={(e) => changeStatus(o, e.currentTarget.value)}>
          <option value="open">Open</option>
          <option value="in-progress">In progress</option>
          <option value="done">Done</option>
        </select>
        <button class="escalate" disabled={o.priority === "urgent" || o.id < 0} onclick={() => escalate(o)}>Escalate</button>
        <button class="delete" disabled={o.id < 0} onclick={() => remove(o)}>Delete</button>
      </li>
    {:else}
      <li class="none">Nothing here.</li>
    {/each}
  </ul>
</main>
