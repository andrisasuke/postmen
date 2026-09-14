<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "ghost" | "danger" | "soft";
    disabled?: boolean;
  }>(),
  { variant: "secondary", disabled: false },
);
</script>
<template>
  <button
    type="button"
    :class="['ui-button', `button-${variant}`]"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>
