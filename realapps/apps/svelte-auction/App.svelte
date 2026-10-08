<script lang="ts">
  import { onMount } from "svelte";
  import { auction, start, end, bid, setView, BID_GUARD, ME } from "./auction";

  const shown = $derived(
    $auction.view === "leading" ? $auction.lots.filter((l) => l.leader === ME) : $auction.view === "outbid" ? $auction.lots.filter((l) => l.leader !== ME) : $auction.lots,
  );
  onMount(() => {
    start();
    return end;
  });
</script>

<div class="auction">
  <header>
    <h1>Spring charity auction</h1>
    <p class="reserved">{$auction.reserved} points reserved in leading bids · {$auction.live ? "live" : "reconnecting…"}</p>
  </header>
  <nav class="view">
    <button class:current={$auction.view === "all"} onclick={() => setView("all")}>All lots</button>
    <button class:current={$auction.view === "leading"} onclick={() => setView("leading")}>Leading</button>
    <button class:current={$auction.view === "outbid"} onclick={() => setView("outbid")}>Outbid</button>
  </nav>
  {#if $auction.error}<p role="alert">{$auction.error}</p>{:else if $auction.notice}<p class="notice">{$auction.notice}</p>{/if}
  <ul class="lots">
    {#each shown as l (l.id)}
      <li class="lot" class:mine={l.leader === ME}>
        <strong>{l.title}</strong> · {l.bid} pts {l.leader ? `· ${l.leader === ME ? "you lead" : `${l.leader} leads`}` : "· no bids"}
        {#if l.open && l.leader !== ME}
          <button class="bid" disabled={BID_GUARD && $auction.pending.includes(l.id)} onclick={() => bid(l, 10)}>Bid +10</button>
          <button class="bid-big" disabled={BID_GUARD && $auction.pending.includes(l.id)} onclick={() => bid(l, 50)}>+50</button>
        {:else if !l.open}<em>closed</em>{/if}
      </li>
    {/each}
  </ul>
</div>
