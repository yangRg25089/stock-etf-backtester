import type {
  APIErrorResponse,
  Diagnostic,
  DraftValidationRequest,
  DraftValidationResponse,
  RunProgress,
  RunResponse,
  RunScope,
  RunSubmissionRequest,
  StrategyStatus,
  InstrumentMetadata,
  MetricSummary,
  StrategyRun,
} from "./generated";

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "loading",
  "running",
  "completed",
  "completed_with_warning",
  "unavailable",
  "failed",
  "cancelled",
]);

export interface RunProgressEvent {
  runId: string;
  status: StrategyStatus;
  progress: RunProgress | null;
  strategyStatuses: Record<string, StrategyStatus>;
  strategySummaries?: Record<string, { metrics: MetricSummary | null; diagnostics: Diagnostic[] }>;
}

export class RunApiError extends Error {
  readonly code: string;
  readonly messageKey: string;
  readonly diagnostics: Diagnostic[];
  readonly status: number | null;

  constructor(
    code: string,
    messageKey: string,
    diagnostics: Diagnostic[] = [],
    status: number | null = null,
  ) {
    super(messageKey);
    this.name = "RunApiError";
    this.code = code;
    this.messageKey = messageKey;
    this.diagnostics = diagnostics;
    this.status = status;
  }
}

export function fetchInstrument(symbol: string, signal?: AbortSignal): Promise<InstrumentMetadata> {
  return requestJson(`/api/v1/instruments/${encodeURIComponent(symbol)}`, { method: "GET" }, signal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fallbackError(status: number | null): RunApiError {
  return new RunApiError(
    "provider_request_failed",
    status === null ? "api.errors.connection_failed" : "api.errors.invalid_request",
    [{
      code: "provider_request_failed",
      messageKey: status === null ? "api.errors.connection_failed" : "api.errors.invalid_request",
      severity: "error",
    }],
    status,
  );
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
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
    const envelope = isRecord(payload) && isRecord(payload.error)
      ? payload as unknown as APIErrorResponse
      : null;
    if (envelope) {
      throw new RunApiError(
        envelope.error.code,
        envelope.error.messageKey,
        envelope.error.diagnostics ?? [],
        response.status,
      );
    }
    throw fallbackError(response.status);
  }
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
  );
}

export function submitRun(
  draft: Record<string, unknown>,
  scope: RunScope,
  activeStrategyId: string | null,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<RunResponse> {
  const body: RunSubmissionRequest = {
    draft,
    scope,
    ...(scope === "active" ? { activeStrategyId } : {}),
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
  );
}

export function fetchRun(runId: string, signal?: AbortSignal): Promise<RunResponse> {
  return requestJson<RunResponse>(
    `/api/v1/runs/${encodeURIComponent(runId)}`,
    { method: "GET" },
    signal,
  );
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
    const envelope = isRecord(payload) && isRecord(payload.error)
      ? payload as unknown as APIErrorResponse
      : null;
    if (!envelope) throw fallbackError(response.status);
    throw new RunApiError(
      envelope.error.code,
      envelope.error.messageKey,
      envelope.error.diagnostics ?? [],
      response.status,
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
  let terminalReceived = false;
  let streamEnded = false;
  try {
    while (!streamEnded) {
      const chunk = await reader.read();
      streamEnded = chunk.done;
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const frame = buffer.slice(0, separator).replaceAll("\r\n", "\n");
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
          if (!isRunProgressEvent(parsed)) {
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
    if (!terminalReceived) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (!terminalReceived && !signal?.aborted) throw fallbackError(null);
}

function isRunProgressEvent(value: unknown): value is RunProgressEvent {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    typeof value.status !== "string" ||
    !RUN_STATUSES.has(value.status)
  ) {
    return false;
  }
  if (
    value.progress !== null &&
    (!isRecord(value.progress) ||
      typeof value.progress.completedStrategies !== "number" ||
      typeof value.progress.totalStrategies !== "number")
  ) {
    return false;
  }
  if (value.strategySummaries !== undefined && (
    !isRecord(value.strategySummaries) || !Object.values(value.strategySummaries).every(
      summary => isRecord(summary) && (summary.metrics === null || isRecord(summary.metrics)) && Array.isArray(summary.diagnostics),
    )
  )) return false;
  return isRecord(value.strategyStatuses) && Object.values(value.strategyStatuses).every(
    (status) => typeof status === "string" && RUN_STATUSES.has(status),
  );
}

export function fetchLatestRun(signal?: AbortSignal): Promise<RunResponse | null> {
  return requestJson<RunResponse | null>(
    "/api/v1/runs/latest",
    { method: "GET" },
    signal,
  );
}

export function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function stopRun(runId: string, signal?: AbortSignal): Promise<RunResponse> {
  return requestJson(`/api/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" }, signal);
}

export function fetchCandidate(runId: string, candidateId: string, signal?: AbortSignal): Promise<StrategyRun> {
  return requestJson(`/api/v1/runs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(candidateId)}`, { method: "GET" }, signal);
}
