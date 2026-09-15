<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from "vue";
import type { CSSProperties } from "vue";
import type { VariableSuggestion } from "../../services/variables";
import { resolveVariables } from "../../services/variables";
import { errorMessage } from "../../services/data";
defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{
  label: string; placeholder?: string; variables?: VariableSuggestion[];
  disabled?: boolean; readonly?: boolean; completions?: readonly string[];
}>(), { variables: () => [], completions: () => [] });
const value = defineModel<string>({ required: true });
const input = ref<HTMLInputElement>();
const mirror = ref<HTMLElement>();
const tooltip = ref<HTMLElement>();
const hoveredPartIndex = ref<number | null>(null);
const tooltipPosition = ref<CSSProperties>({});
let tooltipCloseTimer: ReturnType<typeof setTimeout> | undefined;
const list = ref<HTMLElement>();
const uid = useId();
const focused = ref(false);
const dismissed = ref(false);
const cursor = ref(0);
const scroll = ref(0);
const selected = ref(0);
const composing = ref(false);
const position = ref<CSSProperties>({});
const popupTarget = shallowRef<HTMLElement | string>("body");
const token = computed(() => {
  if (!focused.value || dismissed.value || composing.value || props.disabled || props.readonly) return null;
  const prefix = value.value.slice(0, cursor.value);
  const start = prefix.lastIndexOf("<<");
  if (start < 0 || /[<>\s]/.test(prefix.slice(start + 2))) return null;
  const suffix = value.value.slice(cursor.value);
  const existingEnd = suffix.match(/^[A-Za-z0-9_.-]*>>/);
  return { start, end: existingEnd ? cursor.value + existingEnd[0].length : cursor.value, query: prefix.slice(start + 2) };
});
const completion = computed(() => {
  if (token.value) return { ...token.value, variable: true };
  if (!focused.value || dismissed.value || composing.value || props.disabled || props.readonly
    || !props.completions.length || !value.value.trim() || value.value.includes("<<")) return null;
  return { start: 0, end: value.value.length, query: value.value.trim(), variable: false };
});
const suggestions = computed(() => {
  const current = completion.value;
  if (!current) return [];
  const query = current.query.toLowerCase();
  return current.variable
    ? props.variables.filter(v => v.name.toLowerCase().includes(query)).slice(0, 50)
    : props.completions.filter(name => name.toLowerCase().startsWith(query)).map(name => ({ name, scope: "" }));
});
const open = computed(() => suggestions.value.length > 0);
interface InputPart {
  text: string;
  state?: "resolved" | "unresolved";
  scope?: VariableSuggestion["scope"];
  resolvedValue?: string;
  failure?: string;
}
const parts = computed(() => {
  const pieces: InputPart[] = [];
  let offset = 0;
  for (const match of value.value.matchAll(/<<[^<>]*>>/g)) {
    pieces.push({ text: value.value.slice(offset, match.index) });
    const part: InputPart = { text: match[0], state: "resolved", scope: props.variables.find(v => v.name === match[0].slice(2, -2))?.scope };
    try { part.resolvedValue = resolveVariables(match[0], props.variables); }
    catch (error) { part.state = "unresolved"; part.failure = errorMessage(error); }
    pieces.push(part);
    offset = match.index + match[0].length;
  }
  pieces.push({ text: value.value.slice(offset) });
  return pieces;
});
const hoveredPart = computed(() => hoveredPartIndex.value === null ? null : parts.value[hoveredPartIndex.value] ?? null);
function keepTooltip() {
  clearTimeout(tooltipCloseTimer);
  tooltipCloseTimer = undefined;
}
function hideTooltip() {
  keepTooltip();
  hoveredPartIndex.value = null;
}
function leaveTooltip() {
  keepTooltip();
  tooltipCloseTimer = setTimeout(hideTooltip, 120);
}
function placeTooltip() {
  const anchor = mirror.value?.querySelector<HTMLElement>(`[data-variable-index="${hoveredPartIndex.value}"]`);
  if (!anchor || !input.value || !tooltip.value) return;
  const rect = anchor.getBoundingClientRect();
  const field = input.value.getBoundingClientRect();
  const box = tooltip.value.getBoundingClientRect();
  const left = Math.max(8, Math.min(Math.max(rect.left, field.left), innerWidth - box.width - 8));
  const below = rect.bottom + 6;
  const top = Math.max(8, Math.min(below + box.height <= innerHeight - 8 ? below : rect.top - box.height - 6, innerHeight - box.height - 8));
  tooltipPosition.value = { left: `${left}px`, top: `${top}px` };
}
function hoverVariable(event: PointerEvent) {
  if (props.disabled || open.value || composing.value || event.buttons || event.pointerType === "touch") { hideTooltip(); return; }
  if (!input.value || !mirror.value || input.value.closest("[inert]")) { hideTooltip(); return; }
  const field = input.value.getBoundingClientRect();
  const clip = mirror.value.getBoundingClientRect();
  const inside = (rect: DOMRect) => event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom;
  if (!inside(field) || !inside(clip)) { hideTooltip(); return; }
  // The native input stays on top for caret/selection. Hit-test the highlighted
  // mirror spans instead of placing interactive elements over the editor.
  const anchor = [...mirror.value.querySelectorAll<HTMLElement>("[data-variable-index]")].find(node => inside(node.getBoundingClientRect()));
  if (!anchor) { hideTooltip(); return; }
  keepTooltip();
  const index = Number(anchor.dataset.variableIndex);
  if (index === hoveredPartIndex.value) return;
  popupTarget.value = input.value.closest<HTMLElement>('[role="dialog"]') ?? "body";
  tooltipPosition.value = { visibility: "hidden" };
  hoveredPartIndex.value = index;
  void nextTick(placeTooltip);
}
function tooltipScroll(event: Event) {
  if (!(event.target instanceof Node) || !tooltip.value?.contains(event.target)) hideTooltip();
}
function tooltipPointerDown(event: PointerEvent) {
  if (!(event.target instanceof Node) || !tooltip.value?.contains(event.target)) hideTooltip();
}
function dismissTooltipKey(event: KeyboardEvent) {
  if (event.key === "Escape" && hoveredPart.value) {
    event.preventDefault(); event.stopPropagation(); hideTooltip();
  }
}
function tooltipVisibility() { if (document.hidden) hideTooltip(); }
function removeTooltipListeners() {
  window.removeEventListener("resize", hideTooltip);
  window.removeEventListener("scroll", tooltipScroll, true);
  window.removeEventListener("blur", hideTooltip);
  window.removeEventListener("keydown", dismissTooltipKey, true);
  document.removeEventListener("pointerdown", tooltipPointerDown, true);
  document.removeEventListener("visibilitychange", tooltipVisibility);
}
watch(() => !!hoveredPart.value, visible => {
  removeTooltipListeners();
  if (!visible) return;
  window.addEventListener("resize", hideTooltip);
  window.addEventListener("scroll", tooltipScroll, true);
  window.addEventListener("blur", hideTooltip);
  window.addEventListener("keydown", dismissTooltipKey, true);
  document.addEventListener("pointerdown", tooltipPointerDown, true);
  document.addEventListener("visibilitychange", tooltipVisibility);
});
watch([parts, () => props.disabled], hideTooltip);
function place() {
  if (!input.value || !open.value) return;
  const rect = input.value.getBoundingClientRect();
  const menuWidth = Math.min(320, innerWidth - 16);
  const height = Math.min(246, list.value?.offsetHeight ?? 246);
  const roomBelow = innerHeight - rect.bottom - 8;
  position.value = { width: `${menuWidth}px`, left: `${Math.max(8, Math.min(rect.left, innerWidth - menuWidth - 8))}px`,
    top: `${roomBelow >= Math.min(height, 120) ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)}px`,
    maxHeight: `${roomBelow >= Math.min(height, 120) ? Math.min(246, roomBelow) : Math.min(246, rect.top - 8)}px` };
}
function sync(reopen = false) {
  popupTarget.value = input.value?.closest<HTMLElement>('[role="dialog"]') ?? "body";
  cursor.value = input.value?.selectionStart ?? value.value.length;
  scroll.value = input.value?.scrollLeft ?? 0;
  if (reopen) { dismissed.value = false; selected.value = 0; }
  void nextTick(place);
}
function change(event: Event) {
  value.value = (event.target as HTMLInputElement).value;
  sync(true);
}
async function choose(index: number) {
  const v = suggestions.value[index];
  const current = completion.value;
  if (!v || !current) return;
  const replacement = current.variable ? `<<${v.name}>>` : v.name;
  value.value = value.value.slice(0,current.start) + replacement + value.value.slice(current.end);
  dismissed.value = true;
  await nextTick();
  input.value?.focus();
  input.value?.setSelectionRange(current.start + replacement.length, current.start + replacement.length);
  sync();
}
function keydown(event: KeyboardEvent) {
  hideTooltip();
  if (event.isComposing || !open.value) return;
  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault(); event.stopPropagation();
    selected.value = (selected.value + (event.key === "ArrowDown" ? 1 : -1) + suggestions.value.length) % suggestions.value.length;
    void nextTick(() => {
      const option = list.value?.children[selected.value] as HTMLElement | undefined;
      if (option && list.value) {
        if (option.offsetTop < list.value.scrollTop) list.value.scrollTop = option.offsetTop;
        else if (option.offsetTop + option.offsetHeight > list.value.scrollTop + list.value.clientHeight)
          list.value.scrollTop = option.offsetTop + option.offsetHeight - list.value.clientHeight;
      }
    });
  } else if ((event.key === "Enter" && !event.metaKey && !event.ctrlKey) || event.key === "Tab") {
    event.preventDefault(); event.stopPropagation(); void choose(selected.value);
  } else if (event.key === "Escape") {
    event.preventDefault(); event.stopPropagation(); dismissed.value = true;
  }
}
function reposition(event: Event) { if (!(event.target instanceof Node) || !list.value?.contains(event.target)) place(); }
watch(open, enabled => {
  if (enabled) hideTooltip();
  if (enabled) { window.addEventListener("resize", place); window.addEventListener("scroll", reposition, true); void nextTick(place); }
  else { window.removeEventListener("resize", place); window.removeEventListener("scroll", reposition, true); }
});
watch(suggestions, () => { selected.value = 0; if (list.value) list.value.scrollTop = 0; void nextTick(place); });
onBeforeUnmount(() => { hideTooltip(); removeTooltipListeners(); window.removeEventListener("resize", place); window.removeEventListener("scroll", reposition, true); });
defineExpose({ focus: () => input.value?.focus() });
</script>
<template>
  <div class="variable-input" :class="{ disabled }" @pointermove="hoverVariable" @pointerleave="leaveTooltip">
    <div ref="mirror" class="variable-mirror" aria-hidden="true"><span :style="{ transform: `translateX(-${scroll}px)` }"><span v-for="(part, index) in parts" :key="index" :class="part.state" :data-variable-index="part.state ? index : undefined">{{ part.text }}</span></span></div>
    <input v-bind="$attrs" ref="input" class="ui-input variable-textbox" :value="value" :aria-label="label" :placeholder="placeholder"
      :disabled="disabled" :readonly="readonly" role="combobox" aria-autocomplete="list" :aria-expanded="open"
      :aria-controls="open ? uid : undefined" :aria-activedescendant="open ? `${uid}-${selected}` : undefined"
      :aria-describedby="[$attrs['aria-describedby'], hoveredPart ? `${uid}-tooltip` : undefined].filter(Boolean).join(' ') || undefined"
      autocomplete="off" spellcheck="false" autocapitalize="off"
      @input="change" @focus="focused = true; sync(true)" @blur="focused = false"
      @click="sync(true)" @keyup="sync()" @select="sync()" @scroll="sync()" @keydown="keydown"
      @compositionstart="composing = true" @compositionend="composing = false; sync(true)" />
  </div>
  <Teleport :to="popupTarget">
    <div v-if="hoveredPart" :id="`${uid}-tooltip`" ref="tooltip" role="tooltip" class="variable-value-tooltip" :style="tooltipPosition"
      @pointerenter="keepTooltip" @pointerleave="leaveTooltip">
      <div class="variable-tooltip-heading"><span>{{ hoveredPart.text }}</span><small v-if="hoveredPart.scope">{{ hoveredPart.scope }}</small></div>
      <div v-if="hoveredPart.state === 'resolved'" class="variable-tooltip-value">{{ hoveredPart.resolvedValue === '' ? '(empty value)' : hoveredPart.resolvedValue }}</div>
      <div v-else class="variable-tooltip-error">{{ hoveredPart.failure }}</div>
    </div>
    <div v-if="open" :id="uid" ref="list" role="listbox" :aria-label="`${label} ${completion?.variable ? 'variables' : 'suggestions'}`" class="variable-suggestions" :style="position">
      <div v-for="(v,index) in suggestions" :id="`${uid}-${index}`" :key="v.name" role="option" :aria-selected="index === selected"
        :class="{ highlighted: index === selected }" @pointerdown.prevent="choose(index)" @pointermove="selected = index">
        <span>{{ v.name }}</span><small v-if="v.scope">{{ v.scope }}</small>
      </div>
    </div>
  </Teleport>
</template>
<style>
.variable-input { position: relative; min-width: 0; width: 100%; height: 30px; font: inherit; }
.variable-mirror { position: absolute; inset: 1px; display: flex; align-items: center; padding: 3px 7px; overflow: hidden; pointer-events: none; border-radius: inherit; }
.variable-mirror > span { white-space: pre; flex-shrink: 0; }
.variable-mirror .resolved { color: var(--get); }
.variable-mirror .unresolved { color: var(--delete); text-decoration: underline dotted; text-underline-offset: 3px; }
.variable-input .variable-textbox { position: relative; height: 100%; color: transparent; caret-color: var(--text); background: transparent; }
.variable-textbox::selection { color: var(--text); background: color-mix(in srgb, var(--primary) 30%, transparent); }
.variable-input.disabled { opacity: .5; }
.query-url-input > .variable-input { flex: 1; width: 0; }
.query-url-input .variable-mirror { inset: 0; padding: 0; }
.kv-table .variable-mirror { inset: 0; padding: 2px 4px; }
.variable-suggestions { position: fixed; z-index: 120; overflow: auto; padding: 4px; border: 1px solid var(--border); border-radius: 6px; background: var(--menu-bg); box-shadow: var(--shadow); }
.variable-suggestions [role="option"] { display: flex; gap: 12px; justify-content: space-between; padding: 7px 10px; border-radius: 4px; cursor: pointer; }
.variable-suggestions .highlighted { background: var(--hover); }
.variable-suggestions small { color: var(--muted); }
.variable-value-tooltip { position: fixed; z-index: 125; width: max-content; max-width: min(420px, calc(100vw - 16px)); max-height: min(240px, calc(100dvh - 16px)); overflow: auto; padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--menu-bg); color: var(--text); box-shadow: var(--shadow); font-size: 12px; line-height: 1.5; }
.variable-tooltip-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-bottom: 5px; }
.variable-tooltip-heading > span { overflow-wrap: anywhere; min-width: 0; font-weight: 600; }
.variable-tooltip-heading small { color: var(--muted); flex-shrink: 0; }
.variable-tooltip-value, .variable-tooltip-error { white-space: pre-wrap; overflow-wrap: anywhere; }
.variable-tooltip-value { font-family: var(--font-code); }
.variable-tooltip-error { color: var(--delete); }
</style>
