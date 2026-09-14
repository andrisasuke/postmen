<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { json as jsonLanguage } from "@codemirror/lang-json";
import {
  foldGutter,
  foldKeymap,
  foldAll,
  unfoldAll,
} from "@codemirror/language";
import { codeAppearance, jsonHighlighting } from "../../services/editor-theme";
import { useSettingsStore } from "../../stores/settings";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
const settings = useSettingsStore();
const props = defineProps<{ body: string; json: boolean }>();
const host = ref<HTMLElement>();
const message = ref("");
let editor: EditorView | undefined;
function state() {
  return EditorState.create({
    doc: props.body,
    extensions: [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      lineNumbers(),
      search({ top: true }),
      keymap.of([...searchKeymap, ...foldKeymap]),
      foldGutter({ openText: "▾", closedText: "▸" }),
      props.json ? jsonLanguage() : [],
      jsonHighlighting,
      EditorView.contentAttributes.of({
        "aria-label": "Response body",
        "data-testid": "response-body-text",
      }),
      codeAppearance(settings.resolvedTheme === "dark"),
    ],
  });
}
onMounted(() => {
  if (host.value)
    editor = new EditorView({ parent: host.value, state: state() });
});
watch(
  () => [props.body, props.json, settings.resolvedTheme],
  () => {
    editor?.setState(state());
    message.value = "";
  },
);
onBeforeUnmount(() => editor?.destroy());
async function copy() {
  try {
    await navigator.clipboard.writeText(props.body);
    message.value = "Displayed response copied.";
  } catch {
    message.value =
      "Clipboard unavailable. Select the response and use Cmd/Ctrl+C.";
  }
}
defineExpose({
  copy,
  search: () => editor && openSearchPanel(editor),
  fold: () => editor && foldAll(editor),
  unfold: () => editor && unfoldAll(editor),
});
</script>
<template>
  <div class="response-body-editor">
    <span class="sr-only"
      >Read only response body. Size describes the decompressed preview, not
      wire transfer bytes.</span
    >
    <p v-if="message" class="editor-message" role="status">{{ message }}</p>
    <div ref="host" class="codemirror-host" />
  </div>
</template>
