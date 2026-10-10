<script setup lang="ts">
// A search box written the way a lot of code is: every keystroke fetches, and whichever answer arrives last wins.
// The mock API answers in a random 50-900 ms, so type quickly and an older answer can overwrite a newer one.
// GenClass watches this with no code here: open the overlay (bottom right, development only) to see what it finds.
import { ref, watch } from "vue";

const q = ref("");
const results = ref<string[]>([]);

watch(q, (v) => {
  if (!v) return void (results.value = []);
  fetch(`/api/search?q=${encodeURIComponent(v)}`)
    .then((r) => r.json())
    .then((r: { results: string[] }) => (results.value = r.results));
});
</script>

<template>
  <main style="font-family: system-ui, sans-serif; max-width: 520px; margin: 48px auto; padding: 0 16px">
    <h1>GenClass + Vue</h1>
    <p>Type a city quickly, for example “san”, then look at the GenClass overlay.</p>
    <input v-model="q" placeholder="Search cities" autofocus style="width: 100%; padding: 8px; font-size: 16px" />
    <ul>
      <li v-for="r in results" :key="r">{{ r }}</li>
    </ul>
  </main>
</template>
