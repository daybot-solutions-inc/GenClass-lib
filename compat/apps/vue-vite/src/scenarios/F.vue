<script setup lang="ts">
import { useCounter } from "../stores";
const s = useCounter();
</script>

<template>
  <button data-testid="plus" @click="s.plus()">+1</button>
  <p>Count <span data-testid="count">{{ s.count }}</span>, saved <span data-testid="synced">{{ s.synced }}</span></p>
</template>
