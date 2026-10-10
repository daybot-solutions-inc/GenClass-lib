<script setup lang="ts">
import { usePanels } from "../stores";
const s = usePanels();
</script>

<template>
  <button data-testid="load" @click="s.load()">Load both</button>
  <section>
    <h3>People</h3>
    <ul>
      <li v-for="r in s.left ?? []" :key="r" data-testid="left-row">{{ r }}</li>
    </ul>
  </section>
  <section>
    <h3>Activity</h3>
    <ul>
      <li v-for="r in s.right ?? []" :key="r" data-testid="right-row">{{ r }}</li>
    </ul>
  </section>
</template>
