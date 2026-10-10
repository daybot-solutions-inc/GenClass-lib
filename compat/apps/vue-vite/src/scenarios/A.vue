<script setup lang="ts">
import { useSearch } from "../stores";
const s = useSearch();
</script>

<template>
  <h2>City search</h2>
  <input data-testid="q" :value="s.q" placeholder="Search cities" autocomplete="off" @input="s.setQ(($event.target as HTMLInputElement).value)" />
  <ul>
    <li v-for="r in s.results" :key="r" data-testid="result">{{ r }}</li>
  </ul>
</template>
