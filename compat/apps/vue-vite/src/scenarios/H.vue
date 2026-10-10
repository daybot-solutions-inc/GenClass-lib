<script setup lang="ts">
import { onMounted } from "vue";
import { useItems, useSearch } from "../stores";
const items = useItems();
const search = useSearch();
onMounted(items.load);
</script>

<template>
  <h2>Items</h2>
  <ul>
    <li v-for="i in items.items ?? []" :key="i.id" data-testid="item">{{ i.title }}</li>
  </ul>
  <form @submit.prevent="items.create()">
    <input v-model="items.title" data-testid="title" placeholder="New item" />
    <button data-testid="create" type="submit">Create</button>
  </form>
  <h2>Search</h2>
  <input data-testid="q" :value="search.q" placeholder="Search cities" autocomplete="off" @input="search.setQ(($event.target as HTMLInputElement).value)" />
  <ul>
    <li v-for="r in search.results" :key="r" data-testid="result">{{ r }}</li>
  </ul>
</template>
