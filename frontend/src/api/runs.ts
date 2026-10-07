import { fallbackApiError, readApiError } from "./errors";
import type {
  Diagnostic,
  DraftValidationRequest,
  DraftValidationResponse,
  RunProgressEvent,
  RunResponse,
  RunSubmissionRequest,
  InstrumentMetadata,
  StrategyRun,
} from "./generated";
import { isRunProgressEvent, isRunResponse, isStrategyRun, matchesContract } from "./contractReader";
import { isTerminalRunStatus } from "./runStatus";
export type { RunProgressEvent } from "./generated";

export class RunApiError extends Error {
  readonly code: string;
  readonly messageKey: string;
  readonly diagnostics: Diagnostic[];
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: string,
    messageKey: string,
    diagnostics: Diagnostic[] = [],
    status: number | null = null,
    retryAfterSeconds: number | null = null,
  ) {
    super(messageKey);
    this.name = "RunApiError";
    this.code = code;
    this.messageKey = messageKey;
    this.diagnostics = diagnostics;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function fetchInstrument(symbol: string, signal?: AbortSignal): Promise<InstrumentMetadata> {
  const response = await requestJson<InstrumentMetadata>(`/api/v1/instruments/${encodeURIComponent(symbol)}`, { method: "GET" }, signal, "InstrumentMetadata");
  assertRequestedIdentity(response.symbol, symbol.trim().toUpperCase());
  return response;
}

function fallbackError(status: number | null): RunApiError {
  const error = fallbackApiError(status);
  return new RunApiError(error.code, error.messageKey, error.diagnostics, status);
}

function assertRequestedIdentity(actual: string, requested: string): void {
  if (actual !== requested) throw new RunApiError("invalid_response", "api.errors.invalid_response");
}

type ResponseContract = "RunResponse" | "StrategyRun" | "InstrumentMetadata" | "DraftValidationResponse";

function isResponseForContract(contract: ResponseContract, payload: unknown): boolean {
  switch (contract) {
    case "RunResponse":
      return isRunResponse(payload);
    case "StrategyRun":
      return isStrategyRun(payload);
    default:
      return matchesContract(contract, payload);
  }
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  contract: ResponseContract,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw fallbackError(null);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) throw fallbackError(response.status);
    throw new RunApiError("invalid_response", "api.errors.invalid_response", [], response.status);
  }
  if (!response.ok) {
    const error = readApiError(payload);
    if (error) {
      throw new RunApiError(
        error.code,
        error.messageKey,
        error.diagnostics ?? [],
        response.status,
        error.retryAfterSeconds ?? null,
      );
    }
    throw fallbackError(response.status);
  }
  if (!isResponseForContract(contract, payload)) throw new RunApiError("invalid_response", "api.errors.invalid_response", [], response.status);
  return payload as T;
}

export function validateDraft(
  draft: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<DraftValidationResponse> {
  const body: DraftValidationRequest = { draft };
  return requestJson<DraftValidationResponse>(
    "/api/v1/config/validate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    signal,
    "DraftValidationResponse",
  );
}

export function submitRun(
  draft: Record<string, unknown>,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<RunResponse> {
  const body: RunSubmissionRequest = {
    draft,
    scope: "all_enabled",
  };
  return requestJson<RunResponse>(
    "/api/v1/runs",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
    signal,
    "RunResponse",
  );
}

export async function fetchRun(runId: string, signal?: AbortSignal): Promise<RunResponse> {
  const response = await requestJson<RunResponse>(
    `/api/v1/runs/${encodeURIComponent(runId)}`,
    { method: "GET" },
    signal,
    "RunResponse",
  );
  assertRequestedIdentity(response.runId, runId);
  return response;
}

export async function subscribeToRunEvents(
  runId: string,
  onEvent: (event: RunProgressEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/runs/${encodeURIComponent(runId)}/events`,
      { headers: { Accept: "text/event-stream" }, signal },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw fallbackError(null);
  }

  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw fallbackError(response.status);
    }
    const error = readApiError(payload);
    if (!error) throw fallbackError(response.status);
    throw new RunApiError(
      error.code,
      error.messageKey,
      error.diagnostics ?? [],
      response.status,
      error.retryAfterSeconds ?? null,
    );
  }

  if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
    throw new RunApiError("invalid_response", "api.errors.invalid_response", [], response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new RunApiError("invalid_response", "api.errors.invalid_response", [], response.status);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let previousChunkEndedWithCR = false;
  let terminalReceived = false;
  let streamEnded = false;
  try {
    while (!streamEnded) {
      const chunk = await reader.read();
      streamEnded = chunk.done;
      const text = decoder.decode(chunk.value, { stream: !chunk.done });
      if (text) {
        // CR is a complete line ending; consume a following LF only once, including across chunks.
        const continuation = previousChunkEndedWithCR && text.startsWith("\n") ? text.slice(1) : text;
        buffer += continuation.replace(/\r\n?/g, "\n");
        previousChunkEndedWithCR = text.endsWith("\r");
      }
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const lines = frame.split("\n");
        const eventName = lines.find((line) => line.startsWith("event:"))
          ?.slice("event:".length).trim();
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        if (data) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw new RunApiError("invalid_response", "api.errors.invalid_response", [], response.status);
          }
          if (!isRunProgressEvent(parsed) || parsed.runId !== runId
            || (eventName !== "progress" && eventName !== "terminal")
            || (eventName === "terminal") !== isTerminalRunStatus(parsed.status)) {
            throw new RunApiError("invalid_response", "api.errors.invalid_response", [], response.status);
          }
          onEvent(parsed);
          if (eventName === "terminal") {
            terminalReceived = true;
            return;
          }
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    throw error instanceof RunApiError ? error : fallbackError(null);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (!terminalReceived && !signal?.aborted) throw fallbackError(null);
}

export function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function stopRun(runId: string, signal?: AbortSignal): Promise<RunResponse> {
  const response = await requestJson<RunResponse>(`/api/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" }, signal, "RunResponse");
  assertRequestedIdentity(response.runId, runId);
  return response;
}

export async function fetchCandidate(runId: string, candidateId: string, signal?: AbortSignal): Promise<StrategyRun> {
  const response = await requestJson<StrategyRun>(`/api/v1/runs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(candidateId)}`, { method: "GET" }, signal, "StrategyRun");
  assertRequestedIdentity(response.id, candidateId);
  return response;
}
