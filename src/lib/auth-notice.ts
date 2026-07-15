export type AuthErrorNotice =
  | { code: "SUBJECT_NOT_ALLOWED"; sub: string }
  | { code: "AUTH_CALLBACK_FAILED" };

export function readAuthErrorNotice(): AuthErrorNotice | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("authError");

  if (code === "SUBJECT_NOT_ALLOWED") {
    return { code, sub: params.get("sub") ?? "" };
  }

  if (code === "AUTH_CALLBACK_FAILED") {
    return { code };
  }

  return null;
}

export function clearAuthErrorParams(): void {
  if (window.location.search) {
    window.history.replaceState(null, "", window.location.pathname);
  }
}
