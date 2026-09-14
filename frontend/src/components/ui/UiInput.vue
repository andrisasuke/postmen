<script setup lang="ts">
defineProps<{
  label: string;
  placeholder?: string;
  disabled?: boolean;
  readonly?: boolean;
}>();
const model = defineModel<string>({ default: "" });
</script>
<template>
  <input
    v-model="model"
    class="ui-input"
    :aria-label="label"
    :placeholder="placeholder"
    :disabled="disabled"
    :readonly="readonly"
    autocomplete="off"
    spellcheck="false"
  />
</template>
