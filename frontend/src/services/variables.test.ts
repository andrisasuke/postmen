import { describe, expect, it } from "vitest";
import { environmentVariables, resolveVariables, validateEnvironment } from "./variables";
import type { VariableSuggestion } from "./variables";
import { emptyWorkspace, newRow } from "../types/data";

const variable = (name: string, value: string): VariableSuggestion => ({ name, value, description: "", scope: "Collection" });
describe("environment variables", () => {
  it("uses selected scopes, collection precedence and only enabled variables", () => {
    const data = emptyWorkspace();
    const collection = crypto.randomUUID();
    const global = crypto.randomUUID();
    const local = crypto.randomUUID();
    data.environments = [
      { id: global, collectionId: null, name: "Global", revision: 1, variables: [{ ...newRow(), name: "api_url", value: "https://global.test" },{ ...newRow(), name: "token", value: "global-token" }] },
      { id: local, collectionId: collection, name: "Local", revision: 1, variables: [{ ...newRow(), name: "api_url", value: "https://local.test" },{ ...newRow(), name: "off", value: "disabled", enabled: false }] },
    ];
    data.environmentSelections = [{ collectionId: null, environmentId: global }, { collectionId: collection, environmentId: local }];
    const variables = environmentVariables(data,collection);
    expect(variables.map(v => v.name)).toEqual(["api_url","token"]);
    expect(resolveVariables("<<api_url>>/users",variables)).toBe("https://local.test/users");
    expect(resolveVariables("Bearer <<token>>",variables)).toBe("Bearer global-token");
    expect(resolveVariables("<<api_url>>",environmentVariables(data,crypto.randomUUID()))).toBe("https://global.test");
    expect(() => resolveVariables("<<off>>",variables)).toThrow("not enabled");
  });
  it("resolves nested and repeated placeholders, preserving literal values", () => {
    const values = [variable("api_url","https://example.test"),variable("path","<<api_url>>/users"),variable("value","a&b 日本語")];
    expect(resolveVariables("<<path>>?q=<<value>>&repeat=<<value>>",values)).toBe("https://example.test/users?q=a&b 日本語&repeat=a&b 日本語");
  });
  it("rejects unknown, malformed, cyclic and oversized values", () => {
    expect(() => resolveVariables("<<missing>>",[])).toThrow("not enabled");
    expect(() => resolveVariables("<<unfinished",[])).toThrow("Close each");
    expect(() => resolveVariables("<<bad name>>",[])).toThrow("placeholder");
    expect(() => resolveVariables("<<a>>",[variable("a","<<b>>"),variable("b","<<a>>")])).toThrow("cycle");
    expect(() => resolveVariables("<<large>><<large>>",[variable("large","x".repeat(40000))])).toThrow("64 KiB");
  });
  it("rejects duplicate variable names including disabled rows", () => {
    expect(() => validateEnvironment({ id: null, collectionId: null, revision: null, name: "Local", variables: [{ ...newRow(), name: "api_url" },{ ...newRow(), name: "api_url", enabled: false }] })).toThrow("unique");
  });
});
