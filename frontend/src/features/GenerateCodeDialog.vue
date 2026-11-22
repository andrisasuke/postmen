<script setup lang="ts">
import { defineAsyncComponent, defineComponent, h, onBeforeUnmount, onMounted, ref } from "vue";
import type { RequestDoc } from "../types/data";
import { generateCurl } from "../services/generate-code";
import { errorMessage } from "../services/data";
import UiModal from "../components/ui/UiModal.vue";
import IconButton from "../components/ui/IconButton.vue";

const props = defineProps<{ request: RequestDoc }>();
const emit = defineEmits<{ close: [] }>();
const code = ref("");
const loading = ref(true);
const failure = ref("");
const message = ref("");
const copied = ref(false);
const copying = ref(false);
const plainPreview = ref(false);
// While the chunk loads, Vue assigns this ref to the loading placeholder
// instance, so selectAll is only present once the real editor has mounted.
const preview = ref<{ selectAll?: () => void }>();

// ShellPreview pulls in CodeMirror and its theme; keep it out of the startup
// bundle. The chunk is fetched only once generated code exists, and the dialog
// stays usable while it loads or if it fails.
const PreviewStatus = defineComponent({
  name: "PreviewStatus",
  setup: () => () => h("p", { class: "generate-code-preview-status", role: "status" }, "Loading preview…"),
});
const PreviewUnavailable = defineComponent({
  name: "PreviewUnavailable",
  setup: () => () => null,
});
const ShellPreviewAsync = defineAsyncComponent({
  loader: () => import("../components/editor/ShellPreview.vue"),
  loadingComponent: PreviewStatus,
  errorComponent: PreviewUnavailable,
  delay: 0,
  onError: (_error, _retry, fail) => { plainPreview.value = true; fail(); },
});

let disposed = false;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
function resetCopied() {
  if (copiedTimer !== undefined) clearTimeout(copiedTimer);
  copiedTimer = undefined;
  copied.value = false;
}
function dispose() {
  disposed = true;
  resetCopied();
  copying.value = false;
}
function close() { dispose(); emit("close"); }
onBeforeUnmount(dispose);
onMounted(async () => {
  try {
    const result = await generateCurl(props.request);
    if (!disposed) code.value = result.code;
  } catch (error) {
    if (!disposed) failure.value = errorMessage(error);
  } finally {
    if (!disposed) loading.value = false;
  }
});
async function copy() {
  if (!code.value || disposed || copying.value) return;
  copying.value = true;
  message.value = "";
  try {
    await navigator.clipboard.writeText(code.value);
    if (!disposed) {
      resetCopied();
      copied.value = true;
      copiedTimer = setTimeout(resetCopied, 2000);
    }
  } catch {
    if (!disposed) {
      resetCopied();
      message.value = "Clipboard unavailable. Select the code and use Cmd/Ctrl+C.";
      if (preview.value?.selectAll) preview.value.selectAll();
      else plainPreview.value = true;
    }
  } finally {
    if (!disposed) copying.value = false;
  }
}
</script>
<template>
  <UiModal :open="true" title="Generate Code" panel-class="generate-code-dialog" initial-focus="panel" dismiss-on-backdrop @close="close">
    <p v-if="loading" role="status">Generating cURL…</p>
    <p v-if="failure" class="inline-error" role="alert">{{ failure }}</p>
    <div class="generate-code-preview">
      <ShellPreviewAsync v-if="code && !plainPreview" ref="preview" :code="code" />
      <pre v-else-if="code" class="generate-code-plain" aria-label="Generated cURL code">{{ code }}</pre>
      <IconButton class="generate-code-copy" :class="{ 'generate-code-copied': copied }" label="Copy cURL" :icon="copied ? 'check' : 'copy'" :disabled="!code || copying" @click="copy" />
    </div>
    <span class="sr-only" role="status">{{ copied ? "Copied" : "" }}</span>
    <p v-if="message" class="editor-message" role="status">{{ message }}</p>
  </UiModal>
</template>
<style>
.generate-code-dialog { width: min(800px, calc(100vw - 32px)); height: min(500px, calc(100dvh - 66px)); display: flex; flex-direction: column; }
/* These selectors outrank the global [tabindex]:focus-visible rule while
   retaining focus, the panel's normal border/shadow and keyboard interaction. */
.ui-modal.generate-code-dialog:focus,
.ui-modal.generate-code-dialog:focus-visible { outline: none; }
.generate-code-dialog button:focus,
.generate-code-dialog button:focus-visible,
.generate-code-dialog [tabindex]:focus,
.generate-code-dialog [tabindex]:focus-visible,
.generate-code-dialog [contenteditable]:focus,
.generate-code-dialog [contenteditable]:focus-visible,
.generate-code-dialog .cm-editor.cm-focused { outline: none; box-shadow: none; }
.generate-code-dialog .modal-header { flex-shrink: 0; }
.generate-code-dialog .modal-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.generate-code-preview { position: relative; flex: 1; min-height: 0; overflow: hidden; background: transparent; }
.generate-code-copy { position: absolute; top: 8px; right: 8px; z-index: 1; }
.generate-code-dialog .generate-code-copy.generate-code-copied,
.generate-code-dialog .generate-code-copy.generate-code-copied:not(:disabled):hover { color: var(--toast-success); }
.generate-code-dialog p { margin: 0; flex-shrink: 0; }
.generate-code-dialog .generate-code-preview-status { color: var(--muted); }
.generate-code-dialog .generate-code-plain { margin: 0; height: 100%; padding-right: 44px; overflow: auto; font-family: var(--font-code); color: var(--text); user-select: text; }
.generate-code-dialog .shell-preview { height: 100%; padding-right: 44px; }
/* Override shared CodeMirror surfaces only here. Opaque gutters still cover
   horizontally scrolled code, using the same background as the dialog. */
.generate-code-dialog .shell-preview .cm-editor { background-color: transparent; border: none; outline: none; box-shadow: none; }
.generate-code-dialog .shell-preview .cm-gutters { background-color: var(--modal-bg); border: none; }
</style>
