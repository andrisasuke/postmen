<script setup lang="ts">
import { ref } from "vue";
import { useWorkspaceStore } from "../../stores/workspace";
import { newRow } from "../../types/data";
import type { FormField } from "../../types/data";
import { errorMessage } from "../../services/data";
import UiInput from "../ui/UiInput.vue";
import UiCheckbox from "../ui/UiCheckbox.vue";
import UiButton from "../ui/UiButton.vue";
import IconButton from "../ui/IconButton.vue";
import UiSelect from "../ui/UiSelect.vue";
const fields = defineModel<FormField[]>({ required: true });
const store = useWorkspaceStore();
const selecting = ref(false);
const error = ref("");
function add() {
  if (fields.value.length < 500)
    fields.value.push({ ...newRow(), kind: "text", attachmentId: null });
}
function changeKind(field: FormField, kind: string) {
  field.kind = kind === "file" ? "file" : "text";
  field.attachmentId = null;
}
async function choose(field: FormField) {
  selecting.value = true;
  error.value = "";
  try {
    const file = await store.pickAttachment();
    if (
      file &&
      fields.value.some((f) => f.id === field.id) &&
      field.kind === "file"
    )
      field.attachmentId = file.id;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    selecting.value = false;
  }
}
</script>
<template>
  <div class="multipart-editor kv-table-wrapper">
    <p v-if="error" role="alert" class="inline-error">{{ error }}</p>
    <table class="kv-table multipart-table" aria-label="Multipart fields">
      <thead>
        <tr>
          <th aria-label="Enabled" />
          <th>Name</th>
          <th>Type</th>
          <th>Value / File</th>
          <th>Description</th>
          <th class="row-action-cell" aria-label="Remove" />
        </tr>
      </thead>
      <tbody>
        <tr v-for="(field, index) in fields" :key="field.id">
          <td>
            <UiCheckbox
              v-model="field.enabled"
              :label="`Enable multipart field ${index + 1}`"
            />
          </td>
          <td>
            <UiInput
              v-model="field.name"
              :label="`Multipart name ${index + 1}`"
            />
          </td>
          <td>
            <UiSelect
              :model-value="field.kind"
              :label="`Multipart type ${index + 1}`"
              :options="[
                { value: 'text', label: 'Text' },
                { value: 'file', label: 'File' },
              ]"
              @update:model-value="changeKind(field, $event)"
            />
          </td>
          <td>
            <UiInput
              v-if="field.kind === 'text'"
              v-model="field.value"
              :label="`Multipart value ${index + 1}`"
            />
            <div v-else class="file-field">
              <UiButton :disabled="selecting" @click="choose(field)">{{
                field.attachmentId ? "Change file" : "Choose file"
              }}</UiButton
              ><span
                v-if="field.attachmentId"
                >{{
                  store.attachments[field.attachmentId]?.name ??
                  "Attached file"
                }}</span
              >
            </div>
          </td>
          <td>
            <UiInput
              v-model="field.description"
              :label="`Multipart description ${index + 1}`"
            />
          </td>
          <td class="row-action-cell">
            <IconButton
              :label="`Remove multipart field ${index + 1}`"
              icon="trash"
              @click="fields.splice(index, 1)"
            />
          </td>
        </tr>
      </tbody>
    </table>
    <UiButton class="add-row" :disabled="fields.length >= 500" @click="add"
      >Add multipart field</UiButton
    >
    <p class="muted field-help">
      Files are referenced locally. Enabled fields are uploaded when you Send;
      up to 100 MiB of files per request.
    </p>
  </div>
</template>
