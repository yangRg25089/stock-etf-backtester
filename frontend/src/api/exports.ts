import type { APIErrorResponse, Diagnostic, ExportKind } from "./generated";

export interface CsvExport {
  blob: Blob;
  filename: string;
}

export class ExportApiError extends Error {
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
    this.name = "ExportApiError";
    this.code = code;
    this.messageKey = messageKey;
    this.diagnostics = diagnostics;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fallbackError(status: number | null): ExportApiError {
  const messageKey = status === null ? "api.errors.connection_failed" : "api.errors.invalid_request";
  return new ExportApiError("provider_request_failed", messageKey, [{
    code: "provider_request_failed",
    messageKey,
    severity: "error",
  }], status);
}

function filenameFromDisposition(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
    } catch {
      return fallback;
    }
  }
  const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
  if (quoted) return quoted;
  const plain = disposition.match(/filename=([^;]+)/i)?.[1]?.trim();
  return plain?.replace(/^"|"$/g, "") || fallback;
}

async function responseError(response: Response): Promise<ExportApiError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return fallbackError(response.status);
  }
  if (isRecord(payload) && isRecord(payload.error)) {
    const error = (payload as unknown as APIErrorResponse).error;
    return new ExportApiError(
      error.code,
      error.messageKey,
      error.diagnostics ?? [],
      response.status,
    );
  }
  return fallbackError(response.status);
}

export async function fetchCsvExport(
  runId: string,
  focusedResultId: string,
  kind: ExportKind,
  signal?: AbortSignal,
): Promise<CsvExport> {
  const url = `/api/v1/runs/${encodeURIComponent(runId)}/export/${kind}?focusedResultId=${encodeURIComponent(focusedResultId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "text/csv" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw fallbackError(null);
  }
  if (!response.ok) throw await responseError(response);
  const blob = await response.blob();
  return {
    blob,
    filename: filenameFromDisposition(
      response.headers.get("Content-Disposition"),
      `${runId}-${focusedResultId}-${kind}.csv`,
    ),
  };
}
