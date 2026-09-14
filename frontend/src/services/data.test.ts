import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { nativeDataApi } from "./data";
import { emptyWorkspace } from "../types/data";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
beforeEach(()=>vi.mocked(invoke).mockReset());
it("validates a native workspace and sends exact camelCase inputs",async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(emptyWorkspace());expect(await nativeDataApi.loadWorkspace()).toEqual(emptyWorkspace());expect(invoke).toHaveBeenCalledWith("load_workspace",{});
  const id=crypto.randomUUID();vi.mocked(invoke).mockResolvedValueOnce(null);await nativeDataApi.deleteRequest(id);expect(invoke).toHaveBeenLastCalledWith("delete_request",{id});
});
it("preserves typed conflict errors without accepting malformed responses",async()=>{vi.mocked(invoke).mockRejectedValueOnce({code:"CONFLICT",message:"A newer revision exists"});await expect(nativeDataApi.getRequest(crypto.randomUUID())).rejects.toMatchObject({code:"CONFLICT",message:"A newer revision exists"});vi.mocked(invoke).mockResolvedValueOnce({collections:[]});await expect(nativeDataApi.loadWorkspace()).rejects.toMatchObject({code:"INVALID_RESPONSE"});});
it("does not expose raw IPC errors/paths or accept undefined for Rust unit",async()=>{vi.mocked(invoke).mockRejectedValueOnce("SQL error at /private/path");await expect(nativeDataApi.loadWorkspace()).rejects.toMatchObject({code:"IPC_ERROR"});vi.mocked(invoke).mockResolvedValueOnce(undefined);await expect(nativeDataApi.deleteCollection(crypto.randomUUID())).rejects.toMatchObject({code:"INVALID_RESPONSE"});});
it("native file picking passes no frontend path and cancel is null",async()=>{vi.mocked(invoke).mockResolvedValueOnce(null);expect(await nativeDataApi.pickAttachment()).toBeNull();expect(invoke).toHaveBeenLastCalledWith("pick_attachment",{});});
