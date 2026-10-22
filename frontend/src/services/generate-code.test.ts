import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { generateCurl } from "./generate-code";
import { createMemoryApi } from "../fixtures/memory-api";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.mocked(invoke).mockReset());
async function draft() {
  const api = createMemoryApi();
  const c = await api.createCollection("Synthetic");
  return api.createRequest({ collectionId: c.id, folderId: null, name: "Synthetic" });
}
it("sends a draft to the single generate command and validates exact code", async () => {
  const request = await draft(); request.body = "unsaved\n'";
  const result = { code: "curl --globoff \\\n  --url 'https://example.test'" };
  vi.mocked(invoke).mockResolvedValueOnce(result);
  expect(await generateCurl(request)).toEqual(result);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("generate_curl", { input: { request } });
});
it("reports malformed responses and readable native errors", async () => {
  const request = await draft();
  for (const response of [{}, { code: 123 }, { code: "" }]) {
    vi.mocked(invoke).mockResolvedValueOnce(response);
    await expect(generateCurl(request)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  }
  vi.mocked(invoke).mockRejectedValueOnce({ code: "FILE_UNAVAILABLE", message: "Choose the file again." });
  await expect(generateCurl(request)).rejects.toMatchObject({ code: "FILE_UNAVAILABLE", message: "Choose the file again." });
});
