<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import IconButton from "./IconButton.vue";
const props = defineProps<{
  open: boolean;
  title: string;
  panelClass?: string;
  busy?: boolean;
  initialFocus?: "auto" | "panel";
  dismissOnBackdrop?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDivElement>();
const id = useId();
let previous: HTMLElement | null = null;
let background: HTMLElement | null = null;
let wasInert = false;
let backdropPointerId: number | null = null;
let releasedOnBackdrop = false;
const focusable = () => [
  ...(dialog.value?.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [href], [tabindex="0"]',
  ) ?? []),
];
function restore() {
  if (background) background.inert = wasInert;
  previous?.focus({ preventScroll: true });
  background = null;
}
function resetBackdropGesture() {
  backdropPointerId = null;
  releasedOnBackdrop = false;
}
function backdropPointerDown(event: PointerEvent) {
  resetBackdropGesture();
  if (event.target === event.currentTarget && event.button === 0)
    backdropPointerId = event.pointerId;
}
function backdropPointerUp(event: PointerEvent) {
  releasedOnBackdrop = event.target === event.currentTarget
    && backdropPointerId !== null && event.pointerId === backdropPointerId;
  backdropPointerId = null;
}
function backdropClick(event: MouseEvent) {
  const dismiss = releasedOnBackdrop && event.target === event.currentTarget;
  resetBackdropGesture();
  if (dismiss && props.dismissOnBackdrop && !props.busy) emit("close");
}
watch(
  () => props.open,
  async (open) => {
    resetBackdropGesture();
    if (!open) {
      restore();
      return;
    }
    previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    background = document.getElementById("app");
    if (background) {
      wasInert = background.inert;
      background.inert = true;
    }
    await nextTick();
    if (props.open) {
      const target = props.initialFocus === "panel" ? dialog.value : (
        dialog.value?.querySelector<HTMLElement>("[data-autofocus]") ??
        focusable()[0] ??
        dialog.value
      );
      target?.focus();
    }
  },
  { immediate: true },
);
function keydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (!props.busy) emit("close");
  }
  if (event.key === "Tab") {
    const options = focusable();
    const first = options[0];
    const last = options.at(-1);
    if (!first) {
      event.preventDefault();
      dialog.value?.focus();
    } else if (
      event.shiftKey &&
      (document.activeElement === first ||
        document.activeElement === dialog.value)
    ) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (
      document.activeElement === last || document.activeElement === dialog.value
    )) {
      event.preventDefault();
      first.focus();
    }
  }
}
onBeforeUnmount(restore);
</script>
<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="modal-backdrop"
      @keydown="keydown"
      @pointerdown.capture="backdropPointerDown"
      @pointerup.capture="backdropPointerUp"
      @pointercancel="resetBackdropGesture"
      @click="backdropClick"
    >
      <div
        ref="dialog"
        class="ui-modal"
        :class="panelClass"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="id"
        tabindex="-1"
      >
        <header class="modal-header">
          <h2 :id="id">{{ title }}</h2>
          <IconButton label="Close dialog" icon="x" :disabled="busy" @click="emit('close')" />
        </header>
        <div class="modal-body"><slot /></div>
        <footer v-if="$slots.footer" class="modal-footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
