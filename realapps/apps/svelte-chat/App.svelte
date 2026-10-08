<script>
  import { onMount } from "svelte";
  import { chat, init, loadChannel, send, setDraft, DISABLE } from "./chat";
  onMount(() => { init(); });
</script>

<div class="chat">
  <nav>
    {#each $chat.channels as ch}
      <button class="channel" class:active={ch === $chat.channel} on:click={() => loadChannel(ch)}>#{ch}</button>
    {/each}
  </nav>
  <header>#{$chat.channel} · {$chat.count} messages {#if !$chat.connected}<span class="offline">(offline)</span>{/if}</header>
  <ul class="messages">
    {#each $chat.messages as m (m.id ?? m.clientId)}
      <li class:pending={m.pending}><b>{m.author}</b>: {m.text}</li>
    {/each}
  </ul>
  {#if $chat.error}<p role="alert">{$chat.error}</p>{/if}
  <form on:submit|preventDefault={send}>
    <input name="draft" aria-label="Message" value={$chat.draft} on:input={(e) => setDraft(e.currentTarget.value)} />
    <button class="send" type="submit" disabled={DISABLE && $chat.sending}>Send</button>
  </form>
</div>
