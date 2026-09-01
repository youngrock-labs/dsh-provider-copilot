export { CopilotClient } from "./copilotClient.js";
export type {
    CopilotClientOptions,
    CopilotModel,
    ChatMessage,
    ChatCompletionsRequest,
    BearerRef,
} from "./copilotClient.js";
export { ClientError, type ClientErrorCode } from "./errors.js";
export { redactSecrets } from "./redact.js";
export { parseSseChunks } from "./sse.js";
export type { ChatCompletionChunk, ChatCompletionChoice, ChatCompletionDelta } from "./sse.js";
export {
    fetchWithTimeouts,
    withStreamTimeouts,
    resolveTimeouts,
    type HttpTimeouts,
    type FetchOptions,
} from "./http.js";
