<script setup lang="ts" generic="T extends string | number | null">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import type { CSSProperties } from "vue";
import AppIcon from "./AppIcon.vue";
defineOptions({ inheritAttrs: false });
const props = defineProps<{
  modelValue: T;
  label: string;
  options: { value: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: T] }>();
const id = useId();
const trigger = ref<HTMLButtonElement>();
const popup = ref<HTMLDivElement>();
const target = ref<HTMLElement | string>("body");
const open = ref(false);
const active = ref(-1);
const position = ref<CSSProperties>({});
const selected = computed(() =>
  props.options.findIndex((o) => o.value === props.modelValue),
);
let typeahead = "";
let typedAt = 0;
function close() {
  open.value = false;
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", close);
  window.removeEventListener("blur", close);
  document.removeEventListener("scroll", scroll, true);
}
function outside(e: PointerEvent) {
  if (
    e.target instanceof Node &&
    !trigger.value?.contains(e.target) &&
    !popup.value?.contains(e.target)
  )
    close();
}
function scroll(e: Event) {
  if (e.target instanceof Node && popup.value?.contains(e.target)) return;
  if (open.value) positionPopup();
}
async function reveal() {
  await nextTick();
  const menu = popup.value;
  const option = menu?.querySelector<HTMLElement>(
    `[id="${id}-${active.value}"]`,
  );
  if (!menu || !option) return;
  // Scroll only this popup, never its dialog/document or the request panes.
  if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
  else if (
    option.offsetTop + option.offsetHeight >
    menu.scrollTop + menu.clientHeight
  )
    menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
}
function positionPopup() {
  if (!trigger.value) return;
  const r = trigger.value.getBoundingClientRect();
  const w = popup.value?.offsetWidth ?? 190,
    h = Math.min(popup.value?.offsetHeight ?? 200, innerHeight - 16);
  position.value = {
    left: `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`,
    top: `${Math.max(8, Math.min(r.bottom + 4 + h > innerHeight - 8 ? r.top - h - 4 : r.bottom + 4, innerHeight - h - 8))}px`,
  };
}
async function show() {
  if (props.disabled || open.value || !trigger.value) return;
  // Keep a modal's popup inside its focus/inert boundary, above the backdrop.
  target.value =
    trigger.value.closest<HTMLElement>('[role="dialog"]') ?? "body";
  active.value =
    selected.value >= 0 && !props.options[selected.value]?.disabled
      ? selected.value
      : props.options.findIndex((o) => !o.disabled);
  open.value = true;
  await nextTick();
  if (!open.value || !trigger.value?.isConnected) return;
  positionPopup();
  trigger.value.focus({ preventScroll: true });
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);
  document.addEventListener("scroll", scroll, true);
  void reveal();
}
function commit(index = active.value) {
  const option = props.options[index];
  if (option && !option.disabled) emit("update:modelValue", option.value);
  close();
}
function move(direction: number) {
  const n = props.options.length;
  for (let step = 1; step <= n; step++) {
    const index = (active.value + step * direction + n * 2) % n;
    if (!props.options[index]?.disabled) {
      active.value = index;
      void reveal();
      return;
    }
  }
}
async function keydown(e: KeyboardEvent) {
  if (props.disabled) return;
  if (e.key === "Escape" && open.value) {
    e.preventDefault();
    e.stopPropagation();
    close();
    return;
  }
  if (e.key === "Tab") {
    if (open.value) commit();
    return;
  }
  if (["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
    e.preventDefault();
    if (!open.value) {
      await show();
      return;
    }
    if (e.key === "Enter" || e.key === " ") commit();
    else if (e.key === "Home" || e.key === "End") {
      active.value = e.key === "Home" ? -1 : props.options.length;
      move(e.key === "Home" ? 1 : -1);
    } else move(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    await show();
    const time = Date.now();
    typeahead = time - typedAt > 700 ? e.key : typeahead + e.key;
    typedAt = time;
    const index = props.options.findIndex(
      (o) =>
        !o.disabled &&
        o.label.toLowerCase().startsWith(typeahead.toLowerCase()),
    );
    if (index >= 0) {
      active.value = index;
      void reveal();
    }
  }
}
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close();
  },
);
watch(
  () => JSON.stringify(props.options),
  () => {
    if (open.value) close();
  },
);
onBeforeUnmount(close);
</script>
<template>
  <button
    ref="trigger"
    v-bind="$attrs"
    type="button"
    class="ui-select-trigger"
    role="combobox"
    :aria-label="label"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="open ? id : undefined"
    :aria-activedescendant="open && active >= 0 ? `${id}-${active}` : undefined"
    :disabled="disabled"
    @click="open ? close() : show()"
    @keydown="keydown"
    @blur="close"
  >
    <span>{{ options[selected]?.label ?? "Select…" }}</span
    ><AppIcon name="down" :size="12" />
  </button>
  <Teleport :to="target">
    <div
      v-if="open"
      :id="id"
      ref="popup"
      class="ui-menu ui-select-popup"
      role="listbox"
      :aria-label="label"
      :style="position"
      @pointerdown.prevent
    >
      <div
        v-for="(option, index) in options"
        :id="`${id}-${index}`"
        :key="index"
        role="option"
        :aria-selected="index === selected"
        :aria-disabled="option.disabled || undefined"
        class="menu-item"
        :class="{ selected: index === selected, highlighted: index === active }"
        @click="!option.disabled && commit(index)"
        @pointermove="!option.disabled && (active = index)"
      >
        <span class="menu-check"
          ><AppIcon v-if="index === selected" name="check" :size="14" /></span
        ><span>{{ option.label }}</span>
      </div>
    </div>
  </Teleport>
</template>
