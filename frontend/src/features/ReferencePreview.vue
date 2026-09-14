<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ReferenceRequest } from "../fixtures/reference";
import { responseBody } from "../fixtures/reference";
import { methods } from "../types/shell";
import type { HttpMethod } from "../types/shell";
import SplitPanes from "../components/layout/SplitPanes.vue";
import UiMenu from "../components/ui/UiMenu.vue";
import UiTabs from "../components/ui/UiTabs.vue";
import UiButton from "../components/ui/UiButton.vue";
import IconButton from "../components/ui/IconButton.vue";
import JsonPreview from "../components/editor/JsonPreview.vue";
import KeyValueTable from "../components/editor/KeyValueTable.vue";
const props = defineProps<{ request: ReferenceRequest }>();
const requestTab = ref("params");
const responseTab = ref("body");
const method = ref<HttpMethod>("GET");
const params = ref(props.request.params.map((row) => ({ ...row })));
const headers = ref(props.request.headers.map((row) => ({ ...row })));
watch(
  () => props.request,
  (request) => {
    requestTab.value = request.body ? "body" : "params";
    method.value = request.method;
    params.value = request.params.map((r) => ({ ...r }));
    headers.value = request.headers.map((r) => ({ ...r }));
  },
  { immediate: true },
);
const requestTabs = computed(() => [
  { id: "params", label: "Params", count: params.value.length },
  { id: "body", label: "Body" },
  { id: "headers", label: "Headers", count: headers.value.length },
]);
const responseHeaders = ref([
  {
    id: "type",
    enabled: true,
    name: "Content-Type",
    value: "application/json",
    description: "",
  },
  {
    id: "reference",
    enabled: true,
    name: "X-Reference",
    value: "PostMen M1 fixture",
    description: "",
  },
]);
function setMethod(value: string) {
  if (methods.includes(value as HttpMethod)) method.value = value as HttpMethod;
}
</script>
<template>
  <div class="request-workspace">
    <div class="query-url-wrapper">
      <div class="url-field">
        <UiMenu
          label="HTTP method"
          :items="methods.map((id) => ({ id, label: id }))"
          @select="setMethod"
          ><span
            class="method-label"
            :class="`method-${method.toLowerCase()}`"
            >{{ method }}</span
          ></UiMenu
        ><input
          class="url-input"
          :value="request.url"
          aria-label="Request URL (read-only preview)"
          readonly
        /><IconButton label="Save — available in M2" icon="save" disabled />
      </div>
      <UiButton
        variant="primary"
        disabled
        title="HTTP execution is available in M3"
        >Send</UiButton
      >
    </div>
    <SplitPanes>
      <template #request
        ><div class="pane-toolbar">
          <UiTabs
            v-model="requestTab"
            label="Request sections"
            :tabs="requestTabs"
          /><span class="spacer" /><span
            v-if="requestTab === 'body' && request.body"
            class="body-type"
            >JSON</span
          >
        </div>
        <div v-if="requestTab === 'params'" class="pane-content">
          <div class="section-label">Query</div>
          <KeyValueTable v-model="params" label="Query parameters" />
          <div class="section-label path-label">Path</div>
          <p class="muted preview-hint">
            Read-only request preview. Changes to this table are temporary.
          </p>
        </div>
        <div v-else-if="requestTab === 'headers'" class="pane-content">
          <KeyValueTable v-model="headers" label="Request headers" />
        </div>
        <JsonPreview
          v-else-if="request.body"
          :value="request.body"
          label="Request body preview"
        />
        <div v-else class="pane-placeholder">
          <p>No body for this preview request.</p>
          <span class="muted">Editable JSON and multipart arrive in M2.</span>
        </div>
      </template>
      <template #response
        ><div class="pane-toolbar">
          <UiTabs
            v-model="responseTab"
            label="Response sections"
            :tabs="[
              { id: 'body', label: 'Response' },
              { id: 'headers', label: 'Headers', count: 2 },
            ]"
          /><span class="spacer" />
          <div class="response-meta">
            <span class="response-format">{ } JSON</span
            ><strong
              :class="request.id === 'error' ? 'method-delete' : 'method-get'"
              >{{ request.id === "error" ? "500 Error" : "200 OK" }}</strong
            ><span>2ms</span><span>131B</span>
          </div>
        </div>
        <JsonPreview
          v-if="responseTab === 'body'"
          :value="
            request.id === 'error'
              ? responseBody.replace('true', 'false')
              : responseBody
          "
          label="Static response preview" />
        <div v-else class="pane-content">
          <KeyValueTable
            v-model="responseHeaders"
            label="Response headers"
            readonly
          /></div
      ></template>
    </SplitPanes>
  </div>
</template>
