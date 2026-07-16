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
  StartAppleJournalMediaUploadInput,
  StartAppleJournalMediaUploadResponse,
  StartAppleJournalImportInput,
  StartAppleJournalImportResponse,
  TimelineResponse,
  UpdateEntryInput,
  UpdateEntryResponse,
  UploadEntryMediaResponse,
  UploadAppleJournalMediaPartResponse,
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
  startAppleJournalMediaUploadResponseSchema,
  startAppleJournalImportResponseSchema,
  timelineResponseSchema,
  updateEntryResponseSchema,
  uploadEntryMediaResponseSchema,
  uploadAppleJournalMediaPartResponseSchema,
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

export interface MediaUploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  uploadedParts: number;
  totalParts: number;
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
  signal?: AbortSignal,
): Promise<StartAppleJournalImportResponse> {
  return requestJson("/api/imports/apple-journal", startAppleJournalImportResponseSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}

export function importAppleJournalEntry(
  importId: string,
  input: ImportAppleJournalEntryInput,
  signal?: AbortSignal,
): Promise<ImportAppleJournalEntryResponse> {
  return requestJson(
    `/api/imports/apple-journal/${encodeURIComponent(importId)}/entries`,
    importAppleJournalEntryResponseSchema,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    },
  );
}

export function importAppleJournalMedia(
  importId: string,
  entryId: string,
  media: {
    stream: ReadableStream<Uint8Array>;
    mimeType: string;
    sizeBytes: number;
    fingerprint: string;
    sourcePath: string;
    type: "photo" | "video" | "audio" | "drawing";
    position: number;
    placement: "inline" | "grid" | "cover";
    caption: string;
  },
  signal?: AbortSignal,
  onProgress?: (progress: MediaUploadProgress) => void,
): Promise<ImportAppleJournalMediaResponse> {
  return uploadAppleJournalMediaMultipart(importId, entryId, {
    fingerprint: media.fingerprint,
    sourcePath: media.sourcePath,
    type: media.type,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    position: media.position,
    placement: media.placement,
    caption: media.caption,
  }, media.stream, signal, onProgress);
}

const MEDIA_PART_ATTEMPTS = 3;
const MEDIA_UPLOAD_PART_BYTES = 8 * 1024 * 1024;

function mediaUploadBaseUrl(importId: string, entryId: string): string {
  return `/api/imports/apple-journal/${encodeURIComponent(importId)}/entries/${encodeURIComponent(entryId)}/media/uploads`;
}

function shouldRetryUpload(error: unknown): boolean {
  return !(error instanceof ApiRequestError) || error.status === 429 || error.status >= 500;
}

function retryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      window.clearTimeout(timer);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("Aborted", "AbortError"),
      );
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, 250 * 2 ** attempt);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function uploadAppleJournalMediaPart(
  url: string,
  partNumber: number,
  blob: Blob,
  signal?: AbortSignal,
): Promise<UploadAppleJournalMediaPartResponse> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MEDIA_PART_ATTEMPTS; attempt += 1) {
    try {
      return await requestJson(
        `${url}/${partNumber}`,
        uploadAppleJournalMediaPartResponseSchema,
        {
          method: "PUT",
          headers: {
            "Content-Type": blob.type,
            "X-Media-Size": String(blob.size),
          },
          body: blob,
          signal,
        },
      );
    } catch (error) {
      lastError = error;
      if (!shouldRetryUpload(error) || attempt === MEDIA_PART_ATTEMPTS - 1 || signal?.aborted) {
        throw error;
      }
      await retryDelay(attempt, signal);
    }
  }

  throw lastError;
}

class MediaStreamPartReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private pending: Uint8Array | null = null;
  private ended = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async readPart(size: number, mimeType: string): Promise<Blob> {
    const chunks: ArrayBuffer[] = [];
    let remaining = size;

    while (remaining > 0) {
      if (!this.pending) {
        const { done, value } = await this.reader.read();
        if (done) {
          this.ended = true;
          throw new Error("媒體解壓後的大小小於匯出資訊，已停止上傳。");
        }
        this.pending = value;
      }

      const length = Math.min(remaining, this.pending.byteLength);
      const chunk = new Uint8Array(length);
      chunk.set(this.pending.subarray(0, length));
      chunks.push(chunk.buffer);
      this.pending = length === this.pending.byteLength ? null : this.pending.subarray(length);
      remaining -= length;
    }

    return new Blob(chunks, { type: mimeType });
  }

  async expectEnd(): Promise<void> {
    if (this.pending?.byteLength) {
      throw new Error("媒體解壓後的大小大於匯出資訊，已停止上傳。");
    }
    if (this.ended) return;
    const { done } = await this.reader.read();
    if (!done) throw new Error("媒體解壓後的大小大於匯出資訊，已停止上傳。");
    this.ended = true;
  }

  async cancel(reason?: unknown): Promise<void> {
    if (!this.ended) await this.reader.cancel(reason).catch(() => undefined);
    this.ended = true;
  }
}

async function uploadAppleJournalMediaMultipart(
  importId: string,
  entryId: string,
  input: StartAppleJournalMediaUploadInput,
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  onProgress?: (progress: MediaUploadProgress) => void,
): Promise<ImportAppleJournalMediaResponse> {
  const baseUrl = mediaUploadBaseUrl(importId, entryId);
  const partReader = new MediaStreamPartReader(stream);
  let handlePageHide: (() => void) | undefined;
  let handleAbort: (() => void) | undefined;

  try {
    const started: StartAppleJournalMediaUploadResponse = await requestJson(
      baseUrl,
      startAppleJournalMediaUploadResponseSchema,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal,
      },
    );
    if (started.disposition === "duplicate") {
      const totalParts = Math.ceil(input.sizeBytes / MEDIA_UPLOAD_PART_BYTES);
      onProgress?.({
        uploadedBytes: input.sizeBytes,
        totalBytes: input.sizeBytes,
        uploadedParts: totalParts,
        totalParts,
      });
      return started;
    }

    const uploadUrl = `${baseUrl}/${encodeURIComponent(started.id)}`;
    const abortUrl = `${uploadUrl}/abort`;
    const abortUpload = () => {
      void fetch(abortUrl, {
        method: "POST",
        headers: { Accept: "application/json" },
        keepalive: true,
      }).catch(() => undefined);
    };
    const uploadedParts = new Set(started.uploadedParts);
    let uploadedBytes = [...uploadedParts].reduce((total, partNumber) => {
      const bytes = partNumber < started.partCount
        ? started.partSize
        : input.sizeBytes - started.partSize * (started.partCount - 1);
      return total + Math.max(0, bytes);
    }, 0);
    const reportProgress = () => onProgress?.({
      uploadedBytes,
      totalBytes: input.sizeBytes,
      uploadedParts: uploadedParts.size,
      totalParts: started.partCount,
    });
    reportProgress();
    handlePageHide = () => abortUpload();
    handleAbort = () => abortUpload();
    window.addEventListener("pagehide", handlePageHide, { once: true });
    signal?.addEventListener("abort", handleAbort, { once: true });

    for (let partNumber = 1; partNumber <= started.partCount; partNumber += 1) {
      const partSize =
        partNumber < started.partCount
          ? started.partSize
          : input.sizeBytes - started.partSize * (started.partCount - 1);
      if (partSize <= 0) throw new Error("媒體分段資訊不正確，已停止上傳。");
      const part = await partReader.readPart(partSize, input.mimeType);
      if (uploadedParts.has(partNumber)) continue;
      await uploadAppleJournalMediaPart(
        `${uploadUrl}/parts`,
        partNumber,
        part,
        signal,
      );
      uploadedParts.add(partNumber);
      uploadedBytes += part.size;
      reportProgress();
    }
    await partReader.expectEnd();

    return await requestJson(
      `${uploadUrl}/complete`,
      importAppleJournalMediaResponseSchema,
      { method: "POST", signal },
    );
  } finally {
    if (handlePageHide) window.removeEventListener("pagehide", handlePageHide);
    if (handleAbort) signal?.removeEventListener("abort", handleAbort);
    await partReader.cancel();
  }
}

export function completeAppleJournalImport(
  importId: string,
  input: CompleteAppleJournalImportInput,
  signal?: AbortSignal,
): Promise<CompleteAppleJournalImportResponse> {
  return requestJson(
    `/api/imports/apple-journal/${encodeURIComponent(importId)}/complete`,
    completeAppleJournalImportResponseSchema,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    },
  );
}
