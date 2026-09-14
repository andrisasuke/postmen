<script setup lang="ts">
import { useId } from "vue";
defineProps<{
  label: string;
  tabs: { id: string; label: string; count?: number; disabled?: boolean }[];
}>();
const active = defineModel<string>({ required: true });
const id = useId();
function keydown(event: KeyboardEvent) {
  if (!(event.currentTarget instanceof HTMLElement)) return;
  const tabs = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    ),
  ];
  const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    tabs[index]?.focus();
    tabs[index]?.click();
  }
}
</script>
<template>
  <div
    class="editor-tabs"
    role="tablist"
    :aria-label="label"
    @keydown="keydown"
  >
    <button
      v-for="tab in tabs"
      :id="`${id}-${tab.id}`"
      :key="tab.id"
      role="tab"
      type="button"
      :disabled="tab.disabled"
      :aria-selected="active === tab.id"
      :tabindex="active === tab.id ? 0 : -1"
      :class="{ active: active === tab.id }"
      @click="active = tab.id"
    >
      {{ tab.label }}<sup v-if="tab.count">{{ tab.count }}</sup>
    </button>
  </div>
</template>
