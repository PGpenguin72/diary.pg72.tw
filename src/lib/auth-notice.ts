export type AuthErrorNotice =
  | { code: "SUBJECT_NOT_ALLOWED" }
  | { code: "AUTH_CALLBACK_FAILED" };

export function readAuthErrorNotice(): AuthErrorNotice | null {
  const code = new URLSearchParams(window.location.search).get("authError");
  if (code === "SUBJECT_NOT_ALLOWED" || code === "AUTH_CALLBACK_FAILED") {
    return { code };
  }
  return null;
}

export function clearAuthErrorParams(): void {
  if (window.location.search) {
    window.history.replaceState(null, "", window.location.pathname);
  }
}
