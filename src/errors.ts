import { z } from "zod";

// The closed error-code enum (docs/spec/tool-schemas.md "Error taxonomy").
// Errors are returned in-result (as an `error` field on the tool's own
// output shape), never as MCP transport-level errors — a name that matches
// several stops is a *success* returning candidates, not an error.
export const errorCodeSchema = z.enum([
  "not_found",
  "ambiguous",
  "no_results",
  "unsupported",
  "invalid_argument",
  "upstream_unavailable",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const toolErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
});
export type ToolError = z.infer<typeof toolErrorSchema>;

export function toolError(code: ErrorCode, message: string): ToolError {
  return { code, message };
}
