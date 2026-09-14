import { computed, defineComponent, ref } from "vue";
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { useRequestQuery } from "./useRequestQuery";
import { clone, editable, newRow } from "../types/data";
import type { RequestDoc } from "../types/data";
import type { KeyValueRow } from "../types/shell";
import VariableInput from "../components/editor/VariableInput.vue";
import KeyValueTable from "../components/editor/KeyValueTable.vue";

const row = (name: string, value: string, extra: Partial<KeyValueRow> = {}) => ({ ...newRow(), name, value, ...extra });
function setup(url = "https://example.test/items", params: KeyValueRow[] = []) {
  const draft = ref<RequestDoc>({
    id: crypto.randomUUID(), collectionId: crypto.randomUUID(), folderId: null,
    name: "Query", method: "GET", url, params, headers: [], formData: [], body: "", bodyKind: "none",
    position: 0, revision: 1, createdAt: 0, updatedAt: 0,
  });
  return { draft, ...useRequestQuery(() => draft.value) };
}
const values = (rows: KeyValueRow[]) => rows.map(({ name, value }) => [name, value]);
function sentQuery(doc: RequestDoc) {
  // Mirrors native compose_url: append enabled named rows to the stored URL.
  const result = new URL(doc.url);
  for (const row of doc.params) if (row.enabled && row.name) result.searchParams.append(row.name, row.value);
  return [...result.searchParams];
}

describe("two-way request query editing", () => {
  it("displays existing URL and table query rows without mutating the saved representation", () => {
    const state = setup("https://example.test/items?from=url#fragment", [row("from", "table")]);
    const before = editable(state.draft.value);
    expect(state.url.value).toBe("https://example.test/items?from=url&from=table#fragment");
    expect(values(state.params.value)).toEqual([["from", "url"], ["from", "table"]]);
    expect(editable(state.draft.value)).toBe(before);
    expect(sentQuery(state.draft.value)).toEqual([["from", "url"], ["from", "table"]]);
  });

  it("updates names/values, appends and deletes from the table without duplicate Send query", () => {
    const state = setup("https://example.test/items?delivery_date=20260910#result", [row("warehouse", "jk01")]);
    state.params.value = state.params.value.map((item, index) => index === 0 ? { ...item, value: "20260911" } : item);
    expect(state.url.value).toBe("https://example.test/items?delivery_date=20260911&warehouse=jk01#result");
    expect(state.draft.value.url).toBe("https://example.test/items#result");
    state.params.value = state.params.value.map(item => item.name === "warehouse" ? { ...item, name: "location" } : item);
    state.params.value = [...state.params.value, row("channel", "b2c next day")];
    expect(state.url.value).toContain("location=jk01&channel=b2c%20next%20day");
    expect(sentQuery(state.draft.value)).toEqual([["delivery_date", "20260911"], ["location", "jk01"], ["channel", "b2c next day"]]);
    state.params.value = state.params.value.filter(item => item.name !== "delivery_date");
    expect(state.url.value).not.toContain("delivery_date");
    state.params.value = [];
    expect(state.url.value).toBe("https://example.test/items#result");
  });

  it("updates, renames, inserts and removes URL parameters while preserving row identity/description", () => {
    const first = row("date", "old", { description: "Delivery date" });
    const second = row("warehouse", "jk01", { description: "Warehouse" });
    const state = setup(undefined, [first, second]);
    state.url.value = "https://example.test/items?date=new&warehouse=jk01";
    expect(state.params.value[0]).toEqual({ ...first, value: "new" });
    state.url.value = "https://example.test/items?delivery_date=new&warehouse=jk01";
    expect(state.params.value[0]).toEqual({ ...first, name: "delivery_date", value: "new" });
    state.url.value = "https://example.test/items?first=1&delivery_date=new&warehouse=jk01";
    expect(state.params.value[1]?.id).toBe(first.id);
    expect(state.params.value[2]?.id).toBe(second.id);
    state.url.value = "https://example.test/items?warehouse=jk01";
    expect(state.params.value).toEqual([second]);
    state.url.value = "https://example.test/items";
    expect(state.params.value).toEqual([]);
  });

  it("keeps duplicate names ordered with their own descriptions on URL deletion/reordering", () => {
    const first = row("q", "one", { description: "first" });
    const second = row("q", "two", { description: "second" });
    const state = setup(undefined, [first, second]);
    state.url.value = "https://example.test/items?q=two&q=one";
    expect(state.params.value).toEqual([second, first]);
    state.url.value = "https://example.test/items?q=one";
    expect(state.params.value).toEqual([first]);
  });

  it("retains disabled and new empty rows while changing or clearing the URL", () => {
    const disabled = row("token", "kept", { enabled: false, description: "Do not send" });
    const scratch = row("", "");
    const state = setup(undefined, [row("a", "1"), disabled, scratch, row("b", "2")]);
    expect(state.url.value).toBe("https://example.test/items?a=1&b=2");
    state.url.value = "https://example.test/items?a=3&b=2";
    expect(state.params.value.slice(1, 3)).toEqual([disabled, scratch]);
    state.url.value = "https://example.test/items";
    expect(state.params.value).toEqual([disabled, scratch]);
    state.params.value = state.params.value.map(item => item.id === disabled.id ? { ...item, enabled: true } : item);
    expect(state.url.value).toBe("https://example.test/items?token=kept");
    state.params.value = state.params.value.map(item => ({ ...item, enabled: false }));
    expect(state.url.value).toBe("https://example.test/items");
  });

  it("decodes once, encodes data delimiters and keeps environment placeholders visible", () => {
    const state = setup();
    state.url.value = "<<api_url>>/items?q=hello+world&value=a%26b%3Dc%2Bd%23e&literal=%2520&unicode=%E6%97%A5&<<key>>=<<value>>#frag?not=query";
    expect(values(state.params.value)).toEqual([
      ["q", "hello world"], ["value", "a&b=c+d#e"], ["literal", "%20"], ["unicode", "日"], ["<<key>>", "<<value>>"],
    ]);
    state.params.value = state.params.value.map(item => item.name === "q" ? { ...item, value: "two words" } : item);
    expect(state.url.value).toBe("<<api_url>>/items?q=two%20words&value=a%26b%3Dc%2Bd%23e&literal=%2520&unicode=%E6%97%A5&<<key>>=<<value>>#frag?not=query");
  });

  it("preserves partial URL typing and empty values without forcing caret-disrupting spelling", () => {
    const state = setup();
    for (const suffix of ["?", "?q", "?q=", "?q=%", "?q=%E", "?q=%E6%97%A5", "?q=hello+world&"]) {
      state.url.value = `https://example.test/items${suffix}`;
      expect(state.url.value).toBe(`https://example.test/items${suffix}`);
    }
    state.url.value = "https://example.test/items?flag&empty=";
    expect(values(state.params.value)).toEqual([["flag", ""], ["empty", ""]]);
    state.params.value = state.params.value.map(item => ({ ...item, description: "Note" }));
    expect(state.url.value).toBe("https://example.test/items?flag&empty=");
    state.url.value = "https://example.test/items#fragment?not=query";
    expect(state.params.value).toEqual([]);
  });

  it("does not leave phantom rows when a URL parameter name is temporarily empty", () => {
    const original = row("name", "1", { description: "Retain on rename" });
    const state = setup(undefined, [original]);
    state.url.value = "https://example.test/items?=1";
    expect(state.params.value).toEqual([{ ...original, name: "" }]);
    state.url.value = "https://example.test/items?renamed=1";
    expect(state.params.value).toEqual([{ ...original, name: "renamed" }]);
    state.url.value = "https://example.test/items?=1";
    state.url.value = "https://example.test/items";
    expect(state.params.value).toEqual([]);
  });

  it("encodes emoji and tolerates an unfinished surrogate without throwing during input", () => {
    const state = setup();
    state.params.value = [row("q", "😀")];
    expect(state.url.value).toBe("https://example.test/items?q=%F0%9F%98%80");
    state.params.value = [row("q", "\uD800")];
    expect(state.url.value).toBe("https://example.test/items?q=%EF%BF%BD");
  });

  it("does not dirty unchanged input/table updates and follows save/reload/replaced drafts", () => {
    const state = setup(undefined, [row("q", "old")]);
    const before = editable(state.draft.value);
    const unchangedUrl = state.url.value;
    state.url.value = unchangedUrl;
    state.params.value = clone(state.params.value);
    expect(editable(state.draft.value)).toBe(before);
    state.url.value = "https://example.test/items?q=new&";
    state.draft.value = { ...clone(state.draft.value), revision: 2 };
    expect(state.url.value).toBe("https://example.test/items?q=new&");
    state.draft.value = { ...clone(state.draft.value), params: [row("loaded", "1")] };
    expect(state.url.value).toBe("https://example.test/items?loaded=1");
    const reopened = useRequestQuery(() => state.draft.value);
    expect(reopened.url.value).toBe(state.url.value);
    expect(sentQuery(state.draft.value)).toEqual([["loaded", "1"]]);
  });

  it("synchronizes real URL/table input events including add, checkbox, description and trash", async () => {
    const state = setup(undefined, [row("date", "old")]);
    const wrapper = mount(defineComponent({
      components: { VariableInput, KeyValueTable },
      setup: () => ({ url: state.url, params: state.params, count: computed(() => state.params.value.filter(row => row.enabled).length) }),
      template: '<div><VariableInput v-model="url" label="Request URL" /><span data-count>{{ count }}</span><KeyValueTable v-model="params" label="Query parameters" :variables="[]" editable /></div>',
    }));
    try {
      await wrapper.get('input[aria-label="Query parameters value 1"]').setValue("new");
      expect((wrapper.get('input[aria-label="Request URL"]').element as HTMLInputElement).value).toContain("date=new");
      await wrapper.get('input[aria-label="Request URL"]').setValue("https://example.test/items?renamed=yes&added=2");
      expect((wrapper.get('input[aria-label="Query parameters name 1"]').element as HTMLInputElement).value).toBe("renamed");
      expect(wrapper.get("[data-count]").text()).toBe("2");
      await wrapper.get('input[aria-label="Query parameters description 1"]').setValue("description");
      expect(state.draft.value.params[0]?.description).toBe("description");
      await wrapper.get('input[aria-label="Enable Query parameters row 2"]').setValue(false);
      expect(state.url.value).not.toContain("added=");
      await wrapper.get('button[aria-label="Remove Query parameters row 1"]').trigger("click");
      expect(state.url.value).toBe("https://example.test/items");
      await wrapper.get("button.add-row").trigger("click");
      await wrapper.get('input[aria-label="Query parameters name 2"]').setValue("next");
      await wrapper.get('input[aria-label="Query parameters value 2"]').setValue("3");
      expect(state.url.value).toBe("https://example.test/items?next=3");
    } finally { wrapper.unmount(); }
  });
});
