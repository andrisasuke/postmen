<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  ref,
} from "vue";
import { useExecutionStore } from "../stores/execution";
import UiTabs from "../components/ui/UiTabs.vue";
import UiButton from "../components/ui/UiButton.vue";
import AppIcon from "../components/ui/AppIcon.vue";
import UiMenu from "../components/ui/UiMenu.vue";
import UiSelect from "../components/ui/UiSelect.vue";
import { formatResponse } from "../services/response-format";
const ResponseBody = defineAsyncComponent(
  () => import("../components/editor/ResponseBody.vue"),
);
const props = defineProps<{ id: string }>();
const bodyEditor = ref<InstanceType<typeof ResponseBody>>();
const store = useExecutionStore();
const state = computed(() => store.states[props.id]);
const result = computed(() => state.value?.result);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 100);
});
onBeforeUnmount(() => clearInterval(timer));
const loading = computed(() => state.value && state.value.phase !== "done");
const formatted = computed(() =>
  result.value
    ? formatResponse(
        result.value.body,
        result.value.truncated,
        result.value.binary,
      )
    : { body: "", json: false, limited: false },
);
function bodyAction(id: string) {
  if (id === "search") bodyEditor.value?.search();
  if (id === "copy") void bodyEditor.value?.copy();
  if (id === "fold") bodyEditor.value?.fold();
  if (id === "unfold") bodyEditor.value?.unfold();
}
</script>
<template>
  <div class="pane-toolbar response-toolbar">
    <UiTabs
      label="Response sections"
      :model-value="state?.section ?? 'response'"
      :tabs="[
        { id: 'response', label: 'Response' },
        { id: 'headers', label: 'Headers', count: result?.headers.length ?? 0 },
      ]"
      @update:model-value="
        state && (state.section = $event === 'headers' ? 'headers' : 'response')
      "
    /><span class="spacer" />
    <UiSelect
      v-if="
        state && result?.outcome === 'success' && state.section === 'response'
      "
      v-model="state.format"
      class="response-format"
      label="Response format"
      :options="[
        { value: 'formatted', label: formatted.json ? 'JSON' : 'Text' },
        { value: 'raw', label: 'Raw' },
      ]"
    />
    <div v-if="result?.status" class="response-meta">
      <span :class="result.status >= 400 ? 'http-error' : 'http-success'"
        >{{ result.status }} {{ result.statusText }}</span
      ><span>{{ result.durationMs }}ms</span
      ><span
        :title="'Preview bytes after HTTP content decompression; not wire transfer size.'"
        >{{ result.previewBytes.toLocaleString() }}B</span
      >
    </div>
    <UiMenu
      v-if="
        result?.body &&
        state?.section === 'response' &&
        result.outcome === 'success'
      "
      label="Response actions"
      icon-only
      align="end"
      :items="[
        { id: 'search', label: 'Search response' },
        { id: 'copy', label: 'Copy response' },
        { id: 'fold', label: 'Fold response' },
        { id: 'unfold', label: 'Unfold response' },
      ]"
      @select="bodyAction"
      ><AppIcon name="dots" :size="14"
    /></UiMenu>
  </div>
  <div v-if="loading" class="response-empty" role="status">
    <AppIcon name="send" :size="32" />
    <h3>
      {{ state?.phase === "cancelling" ? "Cancelling…" : "Sending request…" }}
    </h3>
    <p>{{ Math.max(0, now - (state?.startedAt ?? now)) }} ms</p>
    <UiButton
      :disabled="state?.phase === 'cancelling'"
      @click="store.cancel(id).catch(() => {})"
      >Cancel request</UiButton
    >
    <p class="muted">
      Cancellation stops the client; the server may already have processed the
      request.
    </p>
  </div>
  <div
    v-else-if="state?.failure || (result && result.outcome !== 'success')"
    class="response-empty"
    role="alert"
  >
    <AppIcon name="info" :size="32" />
    <h3>
      {{
        result?.outcome === "cancelled"
          ? "Request cancelled"
          : result?.errorCode === "TIMEOUT"
            ? "Request timed out"
            : "Request failed"
      }}
    </h3>
    <p>{{ state?.failure || result?.message }}</p>
    <p v-if="result">{{ result.durationMs }} ms</p>
    <p v-if="result?.historyWarning" class="inline-error">
      {{ result.historyWarning }}
    </p>
  </div>
  <template v-else-if="result">
    <p v-if="result.historyWarning" class="response-notice" role="alert">
      {{ result.historyWarning }}
    </p>
    <p v-if="result.truncated" class="response-notice" role="status">
      Preview truncated at 1 MiB of decompressed bytes. Download stopped;
      duration/size describe the preview, not the complete response.
    </p>
    <p v-if="result.binary" class="response-notice">
      Binary response shown as decoded text ({{ result.bodyEncoding }}); no
      binary download in this milestone.
    </p>
    <div v-if="state?.section === 'headers'" class="response-header-table">
      <p v-if="result.headersTruncated" class="response-notice">
        Header preview truncated.
      </p>
      <table class="kv-table" aria-label="Response headers">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(header, index) in result.headers" :key="index">
            <td>{{ header.name }}</td>
            <td>{{ header.value }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <template v-else>
      <p
        v-if="formatted.limited && state?.format === 'formatted'"
        class="response-notice"
      >
        Formatting safety limit reached; showing raw text.
      </p>
      <ResponseBody
        ref="bodyEditor"
        v-if="result.body"
        :body="state?.format === 'raw' ? result.body : formatted.body"
        :json="formatted.json"
      />
      <div v-else class="response-empty">Empty response body</div></template
    >
  </template>
  <div v-else class="response-empty">
    <AppIcon name="send" :size="32" />
    <h3>No response yet</h3>
    <p>Send this request to see its response.</p>
    <p class="muted">
      {{
        store.ready
          ? "Requests run in the Rust HTTP client."
          : "HTTP is available in the Tauri desktop app."
      }}
    </p>
  </div>
</template>
