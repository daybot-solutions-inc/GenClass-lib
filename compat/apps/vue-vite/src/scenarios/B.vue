<script setup lang="ts">
import { onMounted } from "vue";
import { useItems } from "../stores";
const s = useItems();
onMounted(s.load);
</script>

<template>
  <h2>Items</h2>
  <form @submit.prevent="s.create()">
    <input v-model="s.title" data-testid="title" placeholder="New item" />
    <button data-testid="create" type="submit">Create</button>
  </form>
  <ul>
    <li v-for="i in s.items ?? []" :key="i.id" data-testid="item">{{ i.title }}</li>
  </ul>
  <p v-if="s.error" data-testid="error">{{ s.error }}</p>
</template>
