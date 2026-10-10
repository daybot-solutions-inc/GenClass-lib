<script setup lang="ts">
import { defineComponent, h, onMounted, onUnmounted, ref } from "vue";
import * as api from "../api";
import { useLive } from "../stores";

const on = ref(false);
const LivePanel = defineComponent(() => {
  const s = useLive();
  let stop: (() => void) | null = null;
  onMounted(() => (stop = s.start()));
  onUnmounted(() => stop?.());
  return () =>
    h("div", [
      h("p", ["Tick ", h("span", { "data-testid": "tick" }, String(s.tick)), " after ", h("span", { "data-testid": "polls" }, String(s.polls)), " polls"]),
      h(
        "ul",
        api.DETAIL_IDS.map((id) => {
          const d = s.details[id];
          return d ? h("li", { key: id, "data-testid": "detail" }, `${d.name}: ${d.price}`) : h("li", { key: `l${id}` }, "loading");
        }),
      ),
    ]);
});
</script>

<template>
  <button data-testid="start" @click="on = true">Start</button>
  <LivePanel v-if="on" />
</template>
