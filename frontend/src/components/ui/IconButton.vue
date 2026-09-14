<script setup lang="ts">
import AppIcon from "./AppIcon.vue";
defineProps<{
  label: string;
  icon: InstanceType<typeof AppIcon>["$props"]["name"];
  disabled?: boolean;
  active?: boolean;
}>();
</script>
<template>
  <button
    type="button"
    class="icon-button"
    :class="{ active }"
    :disabled="disabled"
    :aria-label="label"
    :title="label"
  >
    <AppIcon :name="icon" />
  </button>
</template>
