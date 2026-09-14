<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import type { CSSProperties } from "vue";
import { useWorkspaceStore } from "../stores/workspace";
import { errorMessage } from "../services/data";
import AppIcon from "../components/ui/AppIcon.vue";
const props = defineProps<{ collectionId: string | null }>();
const emit = defineEmits<{ configure: [scope: "collection" | "global"] }>();
const store = useWorkspaceStore();
const open = ref(false);
const scope = ref<"collection" | "global">("collection");
const search = ref("");
const failure = ref("");
const trigger = ref<HTMLButtonElement>();
const popup = ref<HTMLElement>();
const query = ref<HTMLInputElement>();
const uid = useId();
const style = ref<CSSProperties>({});
const scopeId = computed(() => scope.value === "collection" ? props.collectionId : null);
const available = computed(() => store.data.environments.filter(e => e.collectionId === scopeId.value && e.name.toLowerCase().includes(search.value.toLowerCase())));
const selected = computed(() => store.selectedEnvironment(scopeId.value));
const collection = computed(() => props.collectionId ? store.selectedEnvironment(props.collectionId) : undefined);
const global = computed(() => store.selectedEnvironment(null));
function place() {
  const rect = trigger.value?.getBoundingClientRect();
  if (!rect) return;
  style.value = { right: `${Math.max(8,innerWidth - rect.right)}px`, top: `${rect.bottom + 8}px`, width: `${Math.min(280,innerWidth - 16)}px`, maxHeight: `${Math.max(120,innerHeight - rect.bottom - 20)}px` };
}
function close(restore = false) {
  open.value = false;
  if (restore) trigger.value?.focus({ preventScroll: true });
}
function outside(event: PointerEvent) {
  if (event.target instanceof Node && !trigger.value?.contains(event.target) && !popup.value?.contains(event.target)) close();
}
async function show() {
  if (!store.ready || store.environmentBusy) return;
  scope.value = props.collectionId && (collection.value || !global.value) ? "collection" : "global";
  search.value = ""; failure.value = ""; open.value = true;
  await nextTick(); place(); query.value?.focus();
}
async function select(id: string | null) {
  failure.value = "";
  try { await store.selectEnvironment(scopeId.value,id); close(true); }
  catch (error) { failure.value = errorMessage(error); }
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
  else if (event.key === "Tab") {
    const buttons = [...(popup.value?.querySelectorAll<HTMLElement>('input,button:not(:disabled)') ?? [])];
    if ((!event.shiftKey && document.activeElement === buttons.at(-1)) || (event.shiftKey && document.activeElement === buttons[0])) close();
  } else if (["ArrowDown","ArrowUp"].includes(event.key)) {
    const options = [...(popup.value?.querySelectorAll<HTMLButtonElement>('.environment-choice:not(:disabled)') ?? [])];
    if (!options.length) return;
    event.preventDefault(); event.stopPropagation();
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = index < 0 ? (event.key === "ArrowDown" ? 0 : options.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus({ preventScroll: true });
    const option = options[next];
    const list = option?.parentElement;
    if (option && list) {
      if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
      else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }
}
watch(open, value => {
  if (value) { document.addEventListener("pointerdown", outside, true); window.addEventListener("resize", place); }
  else { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", place); }
});
watch(() => props.collectionId, () => close());
onBeforeUnmount(() => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", place); });
</script>
<template>
  <button ref="trigger" type="button" class="environment-trigger" :class="{ selected: collection || global }" aria-label="Select environment" aria-haspopup="dialog"
    :aria-expanded="open" :aria-controls="open ? uid : undefined" :disabled="!store.ready || store.environmentBusy"
    :title="[collection ? `Collection: ${collection.name}` : '', global ? `Global: ${global.name}` : ''].filter(Boolean).join(' · ') || 'No Environment'"
    @click="open ? close() : show()" @keydown.down.prevent="show()" @keydown.up.prevent="show()">
    <span v-if="collection" class="environment-segment" data-scope="collection">
      <AppIcon name="database" /><span class="environment-name">{{ collection.name }}</span>
    </span>
    <span v-if="global" class="environment-segment" data-scope="global">
      <AppIcon name="world" /><span class="environment-name">{{ global.name }}</span>
    </span>
    <span v-if="!collection && !global" class="environment-segment">
      <AppIcon name="database" /><span class="environment-name">No Environment</span>
    </span>
    <AppIcon class="environment-chevron" name="down" :size="12" />
  </button>
  <Teleport to="body">
    <section v-if="open" :id="uid" ref="popup" class="environment-popover" role="dialog" aria-label="Select environment" :style="style" @keydown="keydown">
      <div class="environment-scope-tabs" aria-label="Environment scope">
        <button type="button" :class="{ active: scope === 'collection' }" :aria-pressed="scope === 'collection'" :disabled="!collectionId || store.environmentBusy" @click="scope = 'collection'; search = ''"><AppIcon name="database" />Collection</button>
        <button type="button" :class="{ active: scope === 'global' }" :aria-pressed="scope === 'global'" :disabled="store.environmentBusy" @click="scope = 'global'; search = ''"><AppIcon name="world" />Global</button>
      </div>
      <div class="environment-search"><AppIcon name="search" /><input ref="query" v-model="search" aria-label="Search environments" placeholder="Search environments..." /></div>
      <p class="environment-scope-hint">{{ scope === 'collection' ? 'Choose for this collection. Global stays unchanged.' : 'Choose globally. Collection stays unchanged.' }}</p>
      <div class="environment-choices">
        <button type="button" class="environment-choice muted" :class="{ selected: !selected }" :aria-pressed="!selected" :disabled="store.environmentBusy" @click="select(null)">No Environment</button>
        <button v-for="env in available" :key="env.id" type="button" class="environment-choice" :class="{ selected: env.id === selected?.id }" :aria-pressed="env.id === selected?.id" :disabled="store.environmentBusy" @click="select(env.id)">{{ env.name }}</button>
        <p v-if="!available.length" class="environment-no-results muted">{{ search ? 'No matching environments' : 'No environments yet' }}</p>
      </div>
      <p v-if="failure" class="inline-error" role="alert">{{ failure }}</p>
      <button type="button" class="environment-configure" :disabled="store.environmentBusy" @click="close(); emit('configure', scope)"><AppIcon name="settings" />Configure</button>
    </section>
  </Teleport>
</template>
<style>
.environment-trigger { display: inline-flex; align-items: center; gap: 0; min-width: 0; max-width: 360px; height: 28px; padding: 0; border: 1px solid var(--border-strong); border-radius: 7px; white-space: nowrap; }
.environment-segment { display: inline-flex; align-items: center; gap: 6px; min-width: 0; height: 100%; padding: 0 9px; flex: 0 1 auto; overflow: hidden; }
.environment-segment + .environment-segment { border-left: 1px solid var(--border-strong); }
.environment-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.environment-segment > .app-icon, .environment-chevron { flex-shrink: 0; }
.environment-trigger.selected .environment-segment > .app-icon { color: var(--primary); }
.environment-chevron { margin-right: 9px; }
.environment-popover { position: fixed; z-index: 65; display: flex; flex-direction: column; padding: 8px 6px 0; border: 1px solid var(--border); border-radius: 8px; background: var(--menu-bg); box-shadow: var(--shadow); }
.environment-scope-tabs { display: flex; padding: 0 12px; gap: 18px; flex-shrink: 0; }
.environment-scope-tabs button { display: flex; align-items: center; gap: 6px; padding: 10px 2px; border-bottom: 2px solid transparent; color: var(--muted); }
.environment-scope-tabs button.active { color: var(--text); border-color: var(--primary); }
.environment-search { display: flex; align-items: center; gap: 8px; margin: 12px 6px; border: 1px solid var(--border-strong); border-radius: 6px; padding: 7px 9px; color: var(--muted); }
.environment-search input { width: 100%; min-width: 0; border: 0; background: transparent; }
.environment-scope-hint { margin: 0 6px 8px; color: var(--muted); font-size: 11px; }
.environment-choices { position: relative; min-height: 80px; overflow: auto; padding-bottom: 16px; }
.environment-choice { display: block; text-align: left; width: 100%; padding: 8px 26px; border-radius: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.environment-choice:hover, .environment-choice:focus-visible { background: var(--hover); }
.environment-choice.selected { color: var(--primary-text); background: color-mix(in srgb, var(--primary) 9%, transparent); }
.environment-no-results { padding: 12px; font-size: 12px; }
.environment-configure { display: flex; align-items: center; justify-content: center; gap: 8px; border-top: 1px solid var(--border); padding: 9px; margin: 0 -6px; border-radius: 0 0 8px 8px; }
.environment-configure:hover { background: var(--hover); }
</style>
