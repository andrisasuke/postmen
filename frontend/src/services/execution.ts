import { z } from "zod";
import { call } from "./data";
import { executionSchema } from "../types/execution";
import type { ExecutionApi } from "../types/execution";
const nothing = z.null().transform(() => undefined);
export const nativeExecutionApi: ExecutionApi = {
  prepare: (input) => call("prepare_execution", { input }, nothing),
  execute: (executionId) =>
    call("execute_request", { executionId }, executionSchema),
  cancel: (executionId) => call("cancel_request", { executionId }, nothing),
};
export const closeGuardReady = () => call("close_guard_ready", {}, nothing);
export const cancelQuit = () => call("cancel_quit", {}, nothing);
export const finishQuit = (discardWindowState = false) =>
  call("finish_quit", { discardWindowState }, nothing);
