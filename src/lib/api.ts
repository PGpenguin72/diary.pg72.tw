import type {
  CreateEntryInput,
  CreateEntryResponse,
  EntryDetail,
  OverviewResponse,
  TimelineResponse,
} from "../../shared/api";
import {
  createEntryResponseSchema,
  entryDetailSchema,
  overviewResponseSchema,
  timelineResponseSchema,
} from "../../shared/schemas";
import type { z } from "zod";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function requestJson<T>(
  input: RequestInfo | URL,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let message = "暫時無法完成這個動作。";

    try {
      const payload: unknown = await response.json();
      if (
        typeof payload === "object" &&
        payload !== null &&
        "error" in payload &&
        typeof payload.error === "object" &&
        payload.error !== null &&
        "message" in payload.error &&
        typeof payload.error.message === "string"
      ) {
        message = payload.error.message;
      }
    } catch {
      // The status code remains the authoritative failure signal.
    }

    throw new ApiRequestError(message, response.status);
  }

  const payload: unknown = await response.json();
  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    throw new ApiRequestError("伺服器回傳的日記格式不完整。", 502);
  }

  return parsed.data;
}

export function getOverview(): Promise<OverviewResponse> {
  return requestJson("/api/overview", overviewResponseSchema);
}

export function getTimeline(): Promise<TimelineResponse> {
  return requestJson("/api/entries?limit=30", timelineResponseSchema);
}

export function getEntry(entryId: string): Promise<EntryDetail> {
  return requestJson(`/api/entries/${encodeURIComponent(entryId)}`, entryDetailSchema);
}

export function createEntry(input: CreateEntryInput): Promise<CreateEntryResponse> {
  return requestJson("/api/entries", createEntryResponseSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}
