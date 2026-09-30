<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { RequestDoc } from "../types/data";
import { generateCurl } from "../services/generate-code";
import { errorMessage } from "../services/data";
import UiModal from "../components/ui/UiModal.vue";
import UiButton from "../components/ui/UiButton.vue";
import IconButton from "../components/ui/IconButton.vue";
import ShellPreview from "../components/editor/ShellPreview.vue";

const props = defineProps<{ request: RequestDoc }>();
const emit = defineEmits<{ close: [] }>();
const code = ref("");
const loading = ref(true);
const failure = ref("");
const message = ref("");
const preview = ref<InstanceType<typeof ShellPreview>>();
let disposed = false;
function close() { disposed = true; emit("close"); }
onBeforeUnmount(() => { disposed = true; });
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
  if (!code.value || disposed) return;
  try {
    await navigator.clipboard.writeText(code.value);
    if (!disposed) message.value = "Copied";
  } catch {
    if (!disposed) {
      message.value = "Clipboard unavailable. Select the code and use Cmd/Ctrl+C.";
      preview.value?.selectAll();
    }
  }
}
</script>
<template>
  <UiModal :open="true" title="Generate Code" panel-class="generate-code-dialog" @close="close">
    <div class="generate-code-toolbar">
      <span>cURL</span>
      <IconButton label="Copy cURL" icon="copy" :disabled="!code" @click="copy" />
    </div>
    <p v-if="loading" role="status">Generating cURL…</p>
    <p v-if="failure" class="inline-error" role="alert">{{ failure }}</p>
    <ShellPreview v-if="code" ref="preview" :code="code" />
    <p v-if="message" class="editor-message" role="status">{{ message }}</p>
    <template #footer><UiButton variant="ghost" @click="close">Close</UiButton></template>
  </UiModal>
</template>
<style>
.generate-code-dialog { width: min(800px, calc(100vw - 32px)); height: min(500px, calc(100dvh - 66px)); display: flex; flex-direction: column; }
.generate-code-dialog .modal-header, .generate-code-dialog .modal-footer { flex-shrink: 0; }
.generate-code-dialog .modal-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.generate-code-toolbar { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.generate-code-dialog p { margin: 0; flex-shrink: 0; }
.generate-code-dialog .shell-preview { flex: 1; min-height: 0; }
</style>
