import { computed, shallowRef } from "vue";
import type { RequestDoc } from "../types/data";
import { newRow } from "../types/data";
import type { KeyValueRow } from "../types/shell";

function splitUrl(text: string) {
  const hash = text.indexOf("#");
  const fragment = hash < 0 ? "" : text.slice(hash);
  const address = hash < 0 ? text : text.slice(0, hash);
  const question = address.indexOf("?");
  return {
    base: (question < 0 ? address : address.slice(0, question)) + fragment,
    query: question < 0 ? "" : address.slice(question + 1),
    hasQuery: question >= 0,
  };
}

function decode(text: string) {
  const spaces = text.replace(/\+/g, " ");
  // Keep unfinished percent escapes editable instead of throwing on a keystroke.
  try { return decodeURIComponent(spaces); } catch { return spaces; }
}

function parseQuery(query: string): KeyValueRow[] {
  return query.split("&").filter(Boolean).map(part => {
    const equal = part.indexOf("=");
    return {
      ...newRow(),
      name: decode(equal < 0 ? part : part.slice(0, equal)),
      value: equal < 0 ? "" : decode(part.slice(equal + 1)),
    };
  });
}

function encode(text: string) {
  // Encode delimiters as data while keeping environment placeholders visible.
  return encodeURIComponent(text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD"))
    .replace(/%3C%3C([A-Za-z0-9_.-]*)%3E%3E/g, "<<$1>>");
}

const visible = (row: KeyValueRow) => row.enabled && row.name !== "";
const pairs = (rows: KeyValueRow[]) => rows.filter(visible)
  .map(row => `${encode(row.name)}=${encode(row.value)}`).join("&");

function withQuery(base: string, query: string, hasQuery = !!query) {
  const hash = base.indexOf("#");
  return (hash < 0 ? base : base.slice(0, hash)) + (hasQuery ? `?${query}` : "")
    + (hash < 0 ? "" : base.slice(hash));
}

function reconcile(incoming: KeyValueRow[], previous: KeyValueRow[], fromUrl: Set<string>) {
  const wasVisible = (row: KeyValueRow) => visible(row) || (row.enabled && fromUrl.has(row.id));
  const old = previous.filter(wasVisible);
  const used = new Set<string>();
  const matches = new Map<number, KeyValueRow>();
  // Reserve unchanged pairs before matching edited values or renamed keys.
  for (const exact of [true, false]) incoming.forEach((row, index) => {
    if (matches.has(index)) return;
    const match = old.find(item => !used.has(item.id) && item.name === row.name
      && (!exact || item.value === row.value));
    if (match) { matches.set(index, match); used.add(match.id); }
  });
  const unmatched = old.filter(row => !used.has(row.id));
  const renamed = incoming.length - matches.size === unmatched.length;
  const next = incoming.map((row, index) => {
    const match = matches.get(index) ?? (renamed ? unmatched.shift() : undefined);
    return match ? { ...match, name: row.name, value: row.value } : row;
  });
  // Disabled and unfinished table rows are not in the URL; retain their metadata.
  const result: KeyValueRow[] = [];
  let index = 0;
  for (const row of previous) {
    if (!wasVisible(row)) result.push({ ...row });
    else if (next[index]) result.push(next[index++]!);
  }
  return { rows: result.concat(next.slice(index)), urlRowIds: next.map(row => row.id) };
}

const signature = (doc: RequestDoc) => JSON.stringify([doc.id, doc.url, doc.params]);

/** A combined editor view; storage/Send still uses URL + separately appended rows. */
export function useRequestQuery(draft: () => RequestDoc | undefined) {
  const presentation = shallowRef<{ signature: string; text: string; urlRowIds: string[] }>();
  const inline = computed(() => {
    const parts = splitUrl(draft()?.url ?? "");
    return { ...parts, rows: parseQuery(parts.query) };
  });
  function urlRowIds() {
    const doc = draft();
    return new Set([
      ...inline.value.rows.map(row => row.id),
      ...(doc && presentation.value?.signature === signature(doc) ? presentation.value.urlRowIds : []),
    ]);
  }
  const params = computed<KeyValueRow[]>({
    get: () => [...inline.value.rows, ...(draft()?.params ?? [])],
    set: rows => {
      const doc = draft();
      if (!doc || JSON.stringify(rows) === JSON.stringify(params.value)) return;
      const oldText = url.value;
      const fromUrl = urlRowIds();
      const queryValues = (items: KeyValueRow[]) => JSON.stringify(items
        .filter(row => visible(row) || (row.enabled && fromUrl.has(row.id)))
        .map(row => [row.name, row.value]));
      const queryChanged = queryValues(rows) !== queryValues(params.value);
      const base = inline.value.base;
      doc.url = base;
      doc.params = rows.map(row => ({ ...row }));
      presentation.value = {
        signature: signature(doc), text: queryChanged ? withQuery(base, pairs(rows)) : oldText,
        urlRowIds: queryChanged ? rows.filter(visible).map(row => row.id) : [...fromUrl],
      };
    },
  });
  const url = computed<string>({
    get: () => {
      const doc = draft();
      if (!doc) return "";
      if (presentation.value?.signature === signature(doc)) return presentation.value.text;
      const extra = pairs(doc.params);
      const raw = inline.value.query;
      const combined = raw + (raw && extra && !raw.endsWith("&") ? "&" : "") + extra;
      return withQuery(inline.value.base, combined, inline.value.hasQuery || !!extra);
    },
    set: text => {
      const doc = draft();
      if (!doc || text === url.value) return;
      const parts = splitUrl(text);
      const next = reconcile(parseQuery(parts.query), params.value, urlRowIds());
      doc.url = parts.base;
      doc.params = next.rows;
      // Preserve exactly what is being typed (including ?, &, % and bare flags).
      presentation.value = { signature: signature(doc), text, urlRowIds: next.urlRowIds };
    },
  });
  return { url, params };
}
