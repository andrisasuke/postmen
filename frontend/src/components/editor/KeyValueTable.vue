<script setup lang="ts">
import type { KeyValueRow } from "../../types/shell";
import UiInput from "../ui/UiInput.vue";
import UiCheckbox from "../ui/UiCheckbox.vue";
import UiButton from "../ui/UiButton.vue";
import IconButton from "../ui/IconButton.vue";
import { newRow } from "../../types/data";
import VariableInput from "./VariableInput.vue";
import type { VariableSuggestion } from "../../services/variables";
import { HEADER_NAMES, headerValueSuggestions } from "../../services/header-suggestions";
defineProps<{ label: string; readonly?: boolean; editable?: boolean; variables?: VariableSuggestion[]; headerAutocomplete?: boolean }>();
const rows = defineModel<KeyValueRow[]>({ required: true });
function updateRow(id: string, patch: Partial<KeyValueRow>) {
  rows.value = rows.value.map(row => row.id === id ? { ...row, ...patch } : row);
}
</script>
<template>
  <div class="kv-table-wrapper">
    <table class="kv-table" :aria-label="label">
      <colgroup>
        <col class="check-col" />
        <col />
        <col />
        <col />
        <col v-if="editable" class="row-action-col" />
      </colgroup>
      <thead>
        <tr>
          <th aria-label="Enabled"></th>
          <th scope="col">Name</th>
          <th scope="col">Value</th>
          <th scope="col">Description</th>
          <th v-if="editable" class="row-action-cell" aria-label="Remove row" />
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in rows" :key="row.id">
          <td>
            <UiCheckbox
              :model-value="row.enabled"
              @update:model-value="updateRow(row.id, { enabled: $event })"
              :label="
                editable
                  ? `Enable ${label} row ${index + 1}`
                  : `Enable ${row.name}`
              "
              :disabled="readonly"
            />
          </td>
          <td>
            <VariableInput
              v-if="variables || headerAutocomplete"
              :model-value="row.name"
              @update:model-value="updateRow(row.id, { name: $event })"
              :completions="headerAutocomplete ? HEADER_NAMES : undefined"
              :label="editable ? `${label} name ${index + 1}` : `${row.id} name`"
              :readonly="readonly"
              :variables="variables"
            />
            <UiInput v-else
              :model-value="row.name"
              @update:model-value="updateRow(row.id, { name: $event })"
              :label="
                editable ? `${label} name ${index + 1}` : `${row.id} name`
              "
              :readonly="readonly"
            />
          </td>
          <td>
            <VariableInput
              v-if="variables || headerAutocomplete"
              :model-value="row.value"
              @update:model-value="updateRow(row.id, { value: $event })"
              :completions="headerAutocomplete ? headerValueSuggestions(row.name) : undefined"
              :label="editable ? `${label} value ${index + 1}` : `${row.name} value`"
              :readonly="readonly"
              :variables="variables"
            />
            <UiInput v-else
              :model-value="row.value"
              @update:model-value="updateRow(row.id, { value: $event })"
              :label="
                editable ? `${label} value ${index + 1}` : `${row.name} value`
              "
              :readonly="readonly"
            />
          </td>
          <td>
            <UiInput
              :model-value="row.description"
              @update:model-value="updateRow(row.id, { description: $event })"
              :label="
                editable
                  ? `${label} description ${index + 1}`
                  : `${row.name} description`
              "
              :readonly="readonly"
            />
          </td>
          <td v-if="editable" class="row-action-cell">
            <IconButton
              :label="`Remove ${label} row ${index + 1}`"
              icon="trash"
              :disabled="readonly"
              @click="rows = rows.filter(item => item.id !== row.id)"
            />
          </td>
        </tr>
        <tr v-if="!editable" class="entry-row">
          <td></td>
          <td><span>Name</span></td>
          <td><span>Value</span></td>
          <td><span>Description</span></td>
        </tr>
      </tbody>
    </table>
    <UiButton
      v-if="editable"
      class="add-row"
      :disabled="readonly || rows.length >= 500"
      @click="rows = [...rows, newRow()]"
      >Add {{ label === "Query parameters" ? "parameter" : "header" }}</UiButton
    >
  </div>
</template>
