<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { clamp, useSettingsStore } from "../../stores/settings";
import AppIcon from "../ui/AppIcon.vue";
const settings = useSettingsStore();
const root = ref<HTMLElement>();
const width = ref(1190);
const height = ref(620);
let observer: ResizeObserver | undefined;
const vertical = computed(
  () => settings.preferences.orientation === "vertical" || width.value < 852,
);
const size = computed(() =>
  vertical.value
    ? clamp(settings.preferences.requestHeight, 150, height.value - 162)
    : clamp(
        settings.preferences.requestWidth ?? width.value / 2.2,
        350,
        width.value - 502,
      ),
);
const requestCollapsed = computed(() => settings.preferences.requestCollapsed);
const responseCollapsed = computed(
  () => settings.preferences.responseCollapsed,
);
const grid = computed(() => {
  const tracks = requestCollapsed.value
    ? "32px 1fr"
    : responseCollapsed.value
      ? "1fr 32px"
      : `${size.value}px 12px minmax(${vertical.value ? "150px" : "490px"}, 1fr)`;
  return vertical.value
    ? { gridTemplateRows: tracks, gridTemplateColumns: "minmax(0, 1fr)" }
    : { gridTemplateColumns: tracks, gridTemplateRows: "minmax(0, 1fr)" };
});
function setSize(value: number) {
  if (vertical.value)
    settings.preferences.requestHeight = clamp(value, 150, height.value - 162);
  else settings.preferences.requestWidth = clamp(value, 350, width.value - 502);
}
let dragging = false;
function move(event: PointerEvent) {
  if (!dragging || !root.value) return;
  const rect = root.value.getBoundingClientRect();
  const offset = vertical.value
    ? event.clientY - rect.top
    : event.clientX - rect.left;
  const extent = vertical.value ? height.value : width.value;
  if (offset < 80) {
    settings.preferences.requestCollapsed = true;
    stop();
  } else if (extent - offset < 80) {
    settings.preferences.responseCollapsed = true;
    stop();
  } else setSize(offset);
}
function stop() {
  dragging = false;
  document.documentElement.classList.remove("resizing");
  window.removeEventListener("pointermove", move);
  window.removeEventListener("pointerup", stop);
  window.removeEventListener("pointercancel", stop);
  window.removeEventListener("blur", stop);
}
function start(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  dragging = true;
  document.documentElement.classList.add("resizing");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
  window.addEventListener("blur", stop);
}
function keydown(event: KeyboardEvent) {
  const delta = event.shiftKey ? 40 : 10;
  if (
    ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home"].includes(
      event.key,
    )
  ) {
    event.preventDefault();
    if (event.key === "Home") setSize(vertical.value ? 380 : width.value / 2.2);
    else
      setSize(
        size.value +
          (event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -delta
            : delta),
      );
  }
}
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (entry) {
      width.value = entry.contentRect.width;
      height.value = entry.contentRect.height;
      // Resolve the default once. Collapsing/resizing the sidebar should keep
      // the user's request-pane width, as in the pinned desktop reference.
      if (settings.preferences.requestWidth === null && width.value >= 852)
        settings.preferences.requestWidth = clamp(width.value / 2.2, 350, width.value - 502);
    }
  });
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  stop();
});
</script>
<template>
  <div
    ref="root"
    class="split-panes"
    :class="{ vertical }"
    :style="grid"
    data-testid="split-panes"
    :data-orientation="vertical ? 'vertical' : 'horizontal'"
  >
    <button
      v-if="requestCollapsed"
      class="collapsed-pane"
      aria-label="Expand request pane"
      @click="settings.togglePane('request')"
    >
      <AppIcon name="right" />Request
    </button>
    <section
      v-else
      class="request-pane"
      aria-label="Request"
      data-testid="request-pane"
    >
      <slot name="request" />
    </section>
    <div
      v-if="!requestCollapsed && !responseCollapsed"
      class="pane-divider"
      :class="{ vertical }"
      role="separator"
      :aria-orientation="vertical ? 'horizontal' : 'vertical'"
      aria-label="Resize request and response"
      :aria-valuenow="Math.round(size)"
      :aria-valuemin="vertical ? 150 : 350"
      :aria-valuemax="
        Math.round(
          vertical ? Math.max(150, height - 162) : Math.max(350, width - 502),
        )
      "
      tabindex="0"
      @pointerdown="start"
      @keydown="keydown"
      @dblclick="setSize(vertical ? 380 : width / 2.2)"
    >
      <span />
    </div>
    <button
      v-if="responseCollapsed"
      class="collapsed-pane"
      aria-label="Expand response pane"
      @click="settings.togglePane('response')"
    >
      <AppIcon name="right" />Response
    </button>
    <section
      v-else
      class="response-pane"
      aria-label="Response"
      data-testid="response-pane"
    >
      <slot name="response" />
    </section>
  </div>
</template>
