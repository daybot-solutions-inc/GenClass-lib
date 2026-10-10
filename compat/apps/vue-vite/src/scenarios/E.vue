<script setup lang="ts">
import { onMounted } from "vue";
import { useNotes } from "../stores";
const s = useNotes();
onMounted(s.load);
</script>

<template>
  <h2>Notes</h2>
  <input v-model="s.draft" data-testid="note-text" placeholder="Note" />
  <button data-testid="note-add" @click="s.add()">Add</button>
  <ul>
    <li v-for="n in s.notes ?? []" :key="n.key" data-testid="note">{{ n.text }}{{ n.pending ? " (pending)" : "" }}</li>
  </ul>
</template>
