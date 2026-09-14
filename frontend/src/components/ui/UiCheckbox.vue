<script setup lang="ts">
defineProps<{ label: string; disabled?: boolean }>();
const model = defineModel<boolean>({ default: false });
</script>
<template>
  <input
    v-model="model"
    type="checkbox"
    class="ui-checkbox"
    :aria-label="label"
    :disabled="disabled"
  />
</template>
