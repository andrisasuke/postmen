<script setup lang="ts">
import { computed } from "vue";
const props = defineProps<{ value: string; label: string }>();
// M1 read-only fixture renderer. Editable CodeMirror and lint/undo belong to M2.
const lines = computed(() =>
  props.value.split("\n").map((line) => {
    const tokens: { text: string; kind: string }[] = [];
    const pattern =
      /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?/g;
    let end = 0;
    for (const match of line.matchAll(pattern)) {
      const start = match.index;
      tokens.push({ text: line.slice(end, start), kind: "" });
      const text = match[0];
      tokens.push({
        text,
        kind: text.startsWith('"')
          ? /^\s*:/.test(line.slice(start + text.length))
            ? "property"
            : "string"
          : /^(true|false|null)$/.test(text)
            ? "atom"
            : "number",
      });
      end = start + text.length;
    }
    tokens.push({ text: line.slice(end), kind: "" });
    return tokens;
  }),
);
</script>
<template>
  <div class="json-preview" role="region" :aria-label="label" tabindex="0">
    <div v-for="(line, index) in lines" :key="index" class="code-line">
      <span class="line-number" aria-hidden="true">{{ index + 1 }}</span
      ><code
        ><span
          v-for="(token, i) in line"
          :key="i"
          :class="token.kind ? `syntax-${token.kind}` : undefined"
          >{{ token.text }}</span
        ></code
      >
    </div>
  </div>
</template>
