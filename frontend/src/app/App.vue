<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import WorkspaceApp from "./WorkspaceApp.vue";
const legacyFixture =
  import.meta.env.DEV &&
  new URLSearchParams(location.search).get("fixture") === "reference";
const LegacyShell = import.meta.env.DEV
  ? defineAsyncComponent(() => import("../fixtures/M1Shell.vue"))
  : null;
</script>
<template>
  <component
    :is="LegacyShell"
    v-if="legacyFixture && LegacyShell"
  /><WorkspaceApp v-else />
</template>
