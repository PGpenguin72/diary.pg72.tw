import type {
  CompleteAppleJournalImportInput,
  CompleteAppleJournalImportResponse,
  CreateEntryInput,
  CreateEntryResponse,
  DeleteEntryResponse,
  EntryDetail,
  ImportAppleJournalEntryInput,
  ImportAppleJournalEntryResponse,
  ImportAppleJournalMediaResponse,
  OverviewResponse,
  RestoreEntryResponse,
  SessionResponse,
  StartAppleJournalImportInput,
  StartAppleJournalImportResponse,
  TimelineResponse,
  UpdateEntryInput,
  UpdateEntryResponse,
  UploadEntryMediaResponse,
} from "../../shared/api";
import {
  completeAppleJournalImportResponseSchema,
  createEntryResponseSchema,
  deleteEntryResponseSchema,
  entryDetailSchema,
  importAppleJournalEntryResponseSchema,
  importAppleJournalMediaResponseSchema,
  overviewResponseSchema,
  removeEntryMediaResponseSchema,
  restoreEntryResponseSchema,
  sessionResponseSchema,
  startAppleJournalImportResponseSchema,
  timelineResponseSchema,
  updateEntryResponseSchema,
  uploadEntryMediaResponseSchema,
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

async function readErrorMessage(response: Response): Promise<string> {
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

  return message;
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
    throw new ApiRequestError(await readErrorMessage(response), response.status);
  }

  const payload: unknown = await response.json();
  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    throw new ApiRequestError("伺服器回傳的日記格式不完整。", 502);
  }

  return parsed.data;
}

async function requestNoContent(input: RequestInfo | URL, init?: RequestInit): Promise<void> {
  const response = await fetch(input, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new ApiRequestError(await readErrorMessage(response), response.status);
  }
}

export function getSession(): Promise<SessionResponse> {
  return requestJson("/api/auth/session", sessionResponseSchema);
}

export function logout(): Promise<void> {
  return requestNoContent("/api/auth/logout", { method: "POST" });
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

export function updateEntry(entryId: string, input: UpdateEntryInput): Promise<UpdateEntryResponse> {
  return requestJson(`/api/entries/${encodeURIComponent(entryId)}`, updateEntryResponseSchema, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function deleteEntry(entryId: string): Promise<DeleteEntryResponse> {
  return requestJson(`/api/entries/${encodeURIComponent(entryId)}`, deleteEntryResponseSchema, {
    method: "DELETE",
  });
}

export function restoreEntry(entryId: string): Promise<RestoreEntryResponse> {
  return requestJson(
    `/api/entries/${encodeURIComponent(entryId)}/restore`,
    restoreEntryResponseSchema,
    { method: "POST" },
  );
}

function mediaTypeFromMime(mimeType: string): "photo" | "video" | "audio" {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "photo";
}

async function fileFingerprint(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function uploadEntryMedia(
  entryId: string,
  file: File,
  position = 0,
): Promise<UploadEntryMediaResponse> {
  const fingerprint = await fileFingerprint(file);
  const query = new URLSearchParams({
    sourcePath: file.name,
    type: mediaTypeFromMime(file.type),
    position: String(position),
    placement: "grid",
    caption: "",
  });

  return requestJson(
    `/api/entries/${encodeURIComponent(entryId)}/media?${query.toString()}`,
    uploadEntryMediaResponseSchema,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Media-Fingerprint": fingerprint,
        "X-Media-Size": String(file.size),
      },
      body: file,
    },
  );
}

export async function removeEntryMedia(entryId: string, mediaId: string): Promise<void> {
  await requestJson(
    `/api/entries/${encodeURIComponent(entryId)}/media/${encodeURIComponent(mediaId)}`,
    removeEntryMediaResponseSchema,
    { method: "DELETE" },
  );
}

export function startAppleJournalImport(
  input: StartAppleJournalImportInput,
): Promise<StartAppleJournalImportResponse> {
  return requestJson("/api/imports/apple-journal", startAppleJournalImportResponseSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function importAppleJournalEntry(
  importId: string,
  input: ImportAppleJournalEntryInput,
): Promise<ImportAppleJournalEntryResponse> {
  return requestJson(
    `/api/imports/apple-journal/${encodeURIComponent(importId)}/entries`,
    importAppleJournalEntryResponseSchema,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export function importAppleJournalMedia(
  importId: string,
  entryId: string,
  media: {
    blob: Blob;
    fingerprint: string;
    sourcePath: string;
    type: "photo" | "video" | "audio" | "drawing";
    position: number;
    placement: "inline" | "grid" | "cover";
    caption: string;
  },
): Promise<ImportAppleJournalMediaResponse> {
  const query = new URLSearchParams({
    sourcePath: media.sourcePath,
    type: media.type,
    position: String(media.position),
    placement: media.placement,
    caption: media.caption,
  });

  return requestJson(
    `/api/imports/apple-journal/${encodeURIComponent(importId)}/entries/${encodeURIComponent(entryId)}/media?${query.toString()}`,
    importAppleJournalMediaResponseSchema,
    {
      method: "POST",
      headers: {
        "Content-Type": media.blob.type || "application/octet-stream",
        "X-Media-Fingerprint": media.fingerprint,
        "X-Media-Size": String(media.blob.size),
      },
      body: media.blob,
    },
  );
}

export function completeAppleJournalImport(
  importId: string,
  input: CompleteAppleJournalImportInput,
): Promise<CompleteAppleJournalImportResponse> {
  return requestJson(
    `/api/imports/apple-journal/${encodeURIComponent(importId)}/complete`,
    completeAppleJournalImportResponseSchema,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}
