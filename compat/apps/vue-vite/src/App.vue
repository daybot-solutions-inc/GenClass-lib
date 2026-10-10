<script setup lang="ts">
// The compat page: ?s=<scenario a-h> (one data layer here: Pinia setup stores).
import { onMounted, ref, type Component } from "vue";
import A from "./scenarios/A.vue";
import B from "./scenarios/B.vue";
import C from "./scenarios/C.vue";
import D from "./scenarios/D.vue";
import E from "./scenarios/E.vue";
import F from "./scenarios/F.vue";
import G from "./scenarios/G.vue";
import H from "./scenarios/H.vue";

const S: Record<string, Component> = { a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H };
const scenario = S[new URLSearchParams(location.search).get("s") ?? "h"] ?? H;
const mounted = ref(false);
onMounted(() => (mounted.value = true));
</script>

<template>
  <div id="compat" :data-ready="mounted ? '1' : '0'">
    <component :is="scenario" />
  </div>
</template>
