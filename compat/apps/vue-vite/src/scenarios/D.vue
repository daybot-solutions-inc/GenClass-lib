<script setup lang="ts">
import { onMounted } from "vue";
import { useTodos } from "../stores";
const s = useTodos();
onMounted(s.load);
</script>

<template>
  <h2>Todos</h2>
  <ul>
    <li v-for="t in s.todos ?? []" :key="t.id" data-testid="todo">
      <label>
        <input type="checkbox" :data-testid="`toggle-${t.id}`" :checked="t.done" @change="s.toggle(t)" />
        {{ t.title }}: {{ t.done ? "done" : "open" }}
      </label>
    </li>
  </ul>
  <p v-if="s.error" data-testid="error">{{ s.error }}</p>
</template>
