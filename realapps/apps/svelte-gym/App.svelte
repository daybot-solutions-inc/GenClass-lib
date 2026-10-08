<script lang="ts">
  import { onMount } from "svelte";
  import { gym, start, stop, loadDay, book, cancel, BOOK_GUARD } from "./gym";

  const DAYS = ["Mon", "Tue", "Wed", "Thu"];
  onMount(() => {
    start();
    return stop;
  });
</script>

<div class="gym">
  <header>
    <h1>Northside Fitness · classes</h1>
    <p class="mine-count">{$gym.count} upcoming {$gym.count === 1 ? "booking" : "bookings"}</p>
    <button class="refresh" onclick={() => loadDay($gym.day)}>Refresh</button>
  </header>
  <nav class="days">
    {#each DAYS as d (d)}<button class:current={$gym.day === d} onclick={() => loadDay(d)}>{d}</button>{/each}
  </nav>
  {#if $gym.error}<p role="alert">{$gym.error}</p>{:else if $gym.notice}<p class="notice">{$gym.notice}</p>{/if}
  {#if $gym.loading}<p class="muted">Loading timetable…</p>{/if}
  <ul class="timetable">
    {#each $gym.classes as c (c.id)}
      <li class="class">
        <strong>{c.time} {c.name}</strong> with {c.coach} · {Math.max(0, c.capacity - c.booked)} of {c.capacity} spots left
        {#if $gym.mine.some((b) => b.classId === c.id)}<em>Booked</em>
        {:else if c.booked < c.capacity}<button class="book" disabled={BOOK_GUARD && $gym.pending.includes(c.id)} onclick={() => book(c)}>Book</button>
        {:else}<span class="full">Full</span>{/if}
      </li>
    {/each}
  </ul>
  <section class="my-bookings">
    <h2>My bookings</h2>
    <ul>
      {#each $gym.mine as b (b.id)}
        <li class="booking">{b.day} {b.time} {b.name} <button class="cancel" disabled={$gym.pending.includes(b.classId)} onclick={() => cancel(b)}>Cancel</button></li>
      {:else}<li class="muted">Nothing booked yet.</li>{/each}
    </ul>
  </section>
</div>
