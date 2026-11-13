import { nextTick, onMounted, onUnmounted, ref, watch, type Ref } from "vue";

export function useTabScroll(activeId: Ref<string | null>) {
  const bar = ref<HTMLElement>();
  const viewport = ref<HTMLElement>();
  const content = ref<HTMLElement>();
  const newAction = ref<HTMLElement>();
  const overflowing = ref(false);
  const canScrollLeft = ref(false);
  const canScrollRight = ref(false);
  let observer: ResizeObserver | undefined;
  let disposed = false;

  function updateEdges() {
    const element = viewport.value;
    if (!element) return;
    canScrollLeft.value = element.scrollLeft > 1;
    canScrollRight.value = element.scrollWidth - element.clientWidth - element.scrollLeft > 1;
  }

  function revealActive() {
    const element = viewport.value;
    const tab = content.value?.querySelector<HTMLElement>(
      `[data-request-tab="${activeId.value}"]`,
    )?.parentElement;
    if (!element || !tab) return;
    const bounds = element.getBoundingClientRect();
    const target = tab.getBoundingClientRect();
    // Move only this strip; scrollIntoView can also scroll surrounding panes.
    if (target.left < bounds.left) element.scrollLeft += target.left - bounds.left;
    else if (target.right > bounds.right) element.scrollLeft += target.right - bounds.right;
    updateEdges();
  }

  async function measure() {
    if (!bar.value || !viewport.value || !content.value || !newAction.value) return;
    const style = getComputedStyle(bar.value);
    const listStyle = getComputedStyle(viewport.value);
    // Measure against the space without arrows so their appearance cannot
    // keep the strip in an overflowing state after tabs are closed.
    const available = bar.value.clientWidth - parseFloat(style.paddingLeft)
      - parseFloat(style.paddingRight) - newAction.value.offsetWidth;
    const required = content.value.offsetWidth + parseFloat(listStyle.paddingLeft)
      + parseFloat(listStyle.paddingRight);
    overflowing.value = required > available + 1;
    await nextTick();
    if (disposed) return;
    revealActive();
    updateEdges();
  }

  function scroll(direction: -1 | 1) {
    const element = viewport.value;
    if (!element) return;
    element.scrollBy({
      left: direction * Math.max(80, element.clientWidth * 0.8),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }

  watch(activeId, () => { void nextTick(revealActive); });
  onMounted(() => {
    observer = new ResizeObserver(() => { void measure(); });
    for (const element of [bar.value, content.value, newAction.value]) {
      if (element) observer.observe(element);
    }
    void measure();
  });
  onUnmounted(() => { disposed = true; observer?.disconnect(); });

  return { bar, viewport, content, newAction, overflowing, canScrollLeft, canScrollRight, updateEdges, scroll };
}
