import type {
  APIErrorResponse,
  Diagnostic,
  DraftValidationRequest,
  DraftValidationResponse,
  RunResponse,
  RunScope,
  RunSubmissionRequest,
} from "./generated";

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
