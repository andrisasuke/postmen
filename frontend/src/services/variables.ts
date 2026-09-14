import type { EnvironmentInput, RequestDoc, Workspace } from "../types/data";
import { clone } from "../types/data";
import { DataError } from "./data";

export interface VariableSuggestion { name: string; value: string; description: string; scope: "Collection" | "Global" }
export const variableName = /^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/;
const bytes = (value: string) => new TextEncoder().encode(value).length;

// Compare editable values, preserving row order while ignoring object key order/revision.
export function environmentContent(input: EnvironmentInput | null): string {
  if (!input) return "null";
  return JSON.stringify({
    collectionId: input.collectionId,
    name: input.name,
    variables: input.variables.map(v => [v.id, v.enabled, v.name, v.value, v.description]),
  });
}

export function environmentVariables(data: Workspace, collectionId: string | null): VariableSuggestion[] {
  const values = new Map<string, VariableSuggestion>();
  for (const scope of collectionId ? [null, collectionId] : [null]) {
    const selected = data.environmentSelections.find(s => s.collectionId === scope)?.environmentId;
    const environment = data.environments.find(e => e.id === selected && e.collectionId === scope);
    for (const v of environment?.variables ?? [])
      if (v.enabled) values.set(v.name, { ...v, scope: scope ? "Collection" : "Global" });
  }
  return [...values.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function validateEnvironment(input: EnvironmentInput) {
  if (!input.name.trim() || [...input.name.trim()].length > 200 || [...input.name].some(c => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)))
    throw new DataError("INVALID_INPUT", "Enter an environment name (1–200 characters).");
  if (input.variables.length > 500) throw new DataError("LIMIT_EXCEEDED", "An environment supports at most 500 variables.");
  const names = new Set<string>();
  for (const v of input.variables) {
    if (!variableName.test(v.name) || names.has(v.name))
      throw new DataError("INVALID_INPUT", "Variable names must be unique, start with a letter or underscore, and use letters, numbers, _, . or -.");
    if (bytes(v.value) > 65536 || bytes(v.description) > 8192)
      throw new DataError("LIMIT_EXCEEDED", "A variable value is limited to 64 KiB and its description to 8 KiB.");
    names.add(v.name);
  }
  if (bytes(JSON.stringify(input.variables)) > 1024 * 1024)
    throw new DataError("LIMIT_EXCEEDED", "An environment is limited to 1 MiB.");
}
export function resolveVariables(text: string, variables: VariableSuggestion[], stack: string[] = []): string {
  let output = "";
  let rest = text;
  while (rest.includes("<<")) {
    const start = rest.indexOf("<<");
    output += rest.slice(0, start);
    const end = rest.indexOf(">>", start + 2);
    if (end < 0) throw new DataError("INVALID_VARIABLE", "Close each variable placeholder with >>.");
    const name = rest.slice(start + 2, end);
    if (!variableName.test(name)) throw new DataError("INVALID_VARIABLE", "Use a variable placeholder such as <<api_url>>.");
    const v = variables.find(v => v.name === name);
    if (!v) throw new DataError("VARIABLE_NOT_FOUND", `Variable <<${name}>> is not enabled in the selected environments.`);
    if (stack.includes(name) || stack.length >= 16) throw new DataError("VARIABLE_CYCLE", "Environment variables contain a cycle or exceed 16 nested references.");
    output += resolveVariables(v.value, variables, [...stack, name]);
    if (bytes(output) > 65536) throw new DataError("LIMIT_EXCEEDED", "Expanded variable content exceeds 64 KiB.");
    rest = rest.slice(end + 2);
  }
  output += rest;
  if (bytes(output) > 65536) throw new DataError("LIMIT_EXCEEDED", "Expanded variable content exceeds 64 KiB.");
  return output;
}
// Browser fixtures mirror native prepare; saved request templates stay untouched.
export function resolveRequest(doc: RequestDoc, variables: VariableSuggestion[]): RequestDoc {
  const result = clone(doc);
  result.url = resolveVariables(result.url, variables);
  for (const rows of [result.params, result.headers]) for (const row of rows) {
    if (!row.enabled || !row.name) continue;
    row.name = resolveVariables(row.name, variables);
    row.value = resolveVariables(row.value, variables);
    if (!row.name) throw new DataError("INVALID_INPUT", "An expanded parameter or header name cannot be empty.");
  }
  return result;
}
