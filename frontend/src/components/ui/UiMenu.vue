<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId } from "vue";
import type { CSSProperties } from "vue";
import type { MenuItem } from "../../types/shell";
import AppIcon from "./AppIcon.vue";
defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    label: string;
    items: MenuItem[];
    align?: "start" | "end";
    side?: "top" | "bottom";
    iconOnly?: boolean;
    disabled?: boolean;
    restorePointerFocus?: boolean;
    menuClass?: string;
  }>(),
  { align: "start", side: "bottom", iconOnly: false, restorePointerFocus: true },
);
const emit = defineEmits<{ select: [id: string] }>();
const open = ref(false);
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLDivElement>();
const id = useId();
let restoreTarget: HTMLElement | undefined;
const position = ref<CSSProperties>({});
const buttons = () => [
  ...(menu.value?.querySelectorAll<HTMLButtonElement>(
    "button:not(:disabled)",
  ) ?? []),
];

function close(restore = true) {
  open.value = false;
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", dismiss);
  window.removeEventListener("blur", dismiss);
  if (restore) (restoreTarget ?? trigger.value)?.focus({ preventScroll: true });
  restoreTarget = undefined;
}
function dismiss() {
  close(false);
}
function outside(event: PointerEvent) {
  if (
    event.target instanceof Node &&
    !trigger.value?.contains(event.target) &&
    !menu.value?.contains(event.target)
  )
    close(false);
}
async function show(
  at?: { x: number; y: number },
  target?: HTMLElement,
  focusFirst = true,
) {
  if (!trigger.value || props.disabled) return;
  restoreTarget = target;
  open.value = true;
  await nextTick();
  if (!open.value || !trigger.value?.isConnected) return;
  const rect = trigger.value.getBoundingClientRect();
  const width = menu.value?.offsetWidth ?? 190;
  const height = menu.value?.offsetHeight ?? 100;
  const left =
    at?.x ?? (props.align === "end" ? rect.right - width : rect.left);
  const top =
    at?.y ?? (props.side === "top" ? rect.top - height - 5 : rect.bottom + 5);
  position.value = {
    left: `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`,
    top: `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`,
  };
  // Pointer-opened menus must not inherit an item's keyboard focus ring.
  // Keep focus inside the menu so Escape and arrow navigation still work.
  const initialFocus = focusFirst ? (buttons()[0] ?? menu.value) : menu.value;
  initialFocus?.focus({ preventScroll: true });
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", dismiss);
  window.addEventListener("blur", dismiss);
}
function keydown(event: KeyboardEvent) {
  const options = buttons();
  const index = options.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
  } else if (event.key === "Tab") close(false);
  else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : index < 0
            ? event.key === "ArrowDown" ? 0 : options.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
              options.length;
    options[next]?.focus();
  } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
    options
      .find((button) =>
        button.textContent
          ?.trim()
          .toLowerCase()
          .startsWith(event.key.toLowerCase()),
      )
      ?.focus();
  }
}
function select(item: MenuItem, event: MouseEvent) {
  if (!item.disabled) {
    // Hover-only sidebar triggers should not gain a persistent focus ring after
    // a pointer action. Keyboard activation still needs its focus return target.
    close(props.restorePointerFocus || event.detail === 0);
    emit("select", item.id);
  }
}
defineExpose({
  isOpen: open,
  id,
  openAt: (x: number, y: number, target?: HTMLElement, focusFirst = false) =>
    show({ x, y }, target, focusFirst),
  close,
});
onBeforeUnmount(() => close(false));
</script>
<template>
  <button
    v-bind="$attrs"
    ref="trigger"
    type="button"
    :disabled="disabled"
    :class="['menu-trigger', { 'icon-button': iconOnly }]"
    :aria-label="label"
    :title="iconOnly ? label : undefined"
    aria-haspopup="menu"
    :aria-expanded="open"
    :aria-controls="open ? id : undefined"
    @click="open ? close() : show(undefined, undefined, $event.detail === 0)"
    @keydown.down.prevent="show()"
    @keydown.up.prevent="show()"
  >
    <slot>{{ label }}</slot>
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      :id="id"
      ref="menu"
      class="ui-menu"
      :class="menuClass"
      role="menu"
      tabindex="-1"
      :aria-label="label"
      :style="position"
      @keydown="keydown"
    >
      <template v-for="item in items" :key="item.id">
      <slot name="before-item" :item="item" />
      <button
        type="button"
        :role="item.checked === undefined ? 'menuitem' : 'menuitemradio'"
        :aria-label="item.label"
        :aria-checked="item.checked"
        :disabled="item.disabled"
        :class="['menu-item', { danger: item.danger, selected: item.checked }]"
        @click="select(item, $event)"
      >
        <slot name="item" :item="item">
        <span class="menu-check"
          ><AppIcon v-if="item.checked" name="check" :size="14" /></span
        ><span>{{ item.label }}</span
        ><kbd v-if="item.shortcut">{{ item.shortcut }}</kbd>
        </slot>
      </button>
      </template>
    </div>
  </Teleport>
</template>
