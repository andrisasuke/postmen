import { z } from "zod";
import type { RequestDoc } from "./data";
export const executionSchema = z.object({
  executionId: z.string().uuid(),
  requestId: z.string().uuid(),
  outcome: z.enum(["success", "error", "cancelled"]),
  status: z.number().int().min(100).max(999).nullable(),
  statusText: z.string(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })),
  headersTruncated: z.boolean(),
  body: z.string(),
  bodyEncoding: z.string(),
  binary: z.boolean(),
  previewBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
  errorCode: z.string().nullable(),
  message: z.string().nullable(),
  historyWarning: z.string().nullable(),
  snapshotWarning: z.string().nullable().optional(),
});
export type ExecutionResult = z.infer<typeof executionSchema>;
export const lastExecutionSchema = z.object({
  completedAt: z.number().int().nonnegative(),
  result: executionSchema,
});
export type LastExecution = z.infer<typeof lastExecutionSchema>;
export interface PrepareExecution {
  executionId: string;
  request: RequestDoc;
  timeoutMs: number;
}
export interface ExecutionApi {
  prepare(input: PrepareExecution): Promise<void>;
  execute(executionId: string): Promise<ExecutionResult>;
  cancel(executionId: string): Promise<void>;
  getLastExecution(requestId: string): Promise<LastExecution | null>;
}
