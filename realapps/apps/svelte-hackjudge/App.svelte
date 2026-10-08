<script lang="ts">
  import { scoresQ, projectsQ, ui, score, setPage, refresh, leaderboard, ME, CRITERIA, ROUND_LOCK, PER_PAGE, PAGES, type Score, type Project, type Criterion } from "./judging";

  const all = $derived(($scoresQ.data?.items ?? []) as Score[]);
  const mine = $derived(all.filter((s) => s.judge === ME));
  const projects = $derived(($projectsQ.data ?? []) as Project[]);
  const board = $derived(leaderboard(all));
  const locked = $derived(ROUND_LOCK && $ui.round !== "open");
  const from = $derived(($ui.page - 1) * PER_PAGE + 1);

  const valueOf = (pid: number, c: Criterion) => String(mine.find((s) => s.projectId === pid && s.criterion === c)?.value ?? "");
  const pageAvg = $derived.by(() => {
    const ids = new Set(projects.map((p) => p.id));
    const xs = mine.filter((s) => ids.has(s.projectId));
    return xs.length ? (xs.reduce((a, s) => a + Number(s.value), 0) / xs.length).toFixed(2) : "–";
  });
</script>

<main class="judging">
  <header>
    <h1>Hack the Harbour — judging</h1>
    <p class="round">{$ui.roundName || "Round"} · {$ui.round === "open" ? "scoring open" : "scoring closed"} · judging as {ME} · {mine.length} of {PAGES * PER_PAGE * CRITERIA.length} scores in{#if $scoresQ.isFetching} · syncing…{/if}</p>
  </header>
  {#if $ui.error}<p role="alert">{$ui.error}</p>{/if}
  {#if $scoresQ.isError && !$scoresQ.data}<p role="alert">Scores couldn't be loaded.</p>{/if}
  {#if $ui.notice}<p class="notice">{$ui.notice}</p>{/if}
  <nav class="pager">
    <button class="prev-tables" disabled={$ui.page <= 1} onclick={() => setPage(-1)}>Previous tables</button>
    <span>Tables {from}–{from + PER_PAGE - 1}</span>
    <button class="next-tables" disabled={$ui.page >= PAGES} onclick={() => setPage(1)}>Next tables</button>
    <button class="refresh" onclick={refresh}>Refresh scores</button>
  </nav>
  {#if $projectsQ.isPending}<p>Loading projects…</p>{/if}
  {#if $projectsQ.isError}<p role="alert">Projects couldn't be loaded.</p>{/if}
  <table class="sheet">
    <thead><tr><th>Table</th><th>Project</th><th>Criterion</th><th>Score</th></tr></thead>
    {#each projects as p (p.id)}
      <tbody class="project">
        {#each CRITERIA as [c, name]}
          <tr class="cell">
            <td>Table {p.table}</td>
            <td><strong>{p.team}</strong> — {p.title} <small>{p.track}</small></td>
            <td>{name}</td>
            <td>
              <select class="score {c}" aria-label="{name} for {p.team}" value={valueOf(p.id, c)} disabled={locked} onchange={(e) => score(p, c, e.currentTarget.value)}>
                <option value="">–</option>
                {#each [1, 2, 3, 4, 5] as n}<option value={String(n)}>{n}</option>{/each}
              </select>
            </td>
          </tr>
        {/each}
      </tbody>
    {/each}
  </table>
  <p class="mine">Your average across these tables: {pageAvg}</p>
  <section class="leaderboard">
    <h2>Leaderboard</h2>
    <ol>
      {#each board as row (row.id)}
        <li class="leader">{row.team} · {row.avg.toFixed(2)} from {row.n} scores</li>
      {:else}
        <li class="none">No scores yet.</li>
      {/each}
    </ol>
  </section>
</main>
