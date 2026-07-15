import { AlertCircle, LogIn } from "lucide-react";
import type { AuthErrorNotice } from "../lib/auth-notice";

interface LoginScreenProps {
  notice: AuthErrorNotice | null;
}

export function LoginScreen({ notice }: LoginScreenProps) {
  return (
    <div className="login-screen">
      <section aria-labelledby="login-title" className="login-card">
        <h1 id="login-title">PG72 Diary</h1>
        <p>這是私人日記，需要登入才能檢視。</p>

        {notice ? (
          <div className="login-card__error" role="alert">
            <AlertCircle aria-hidden="true" size={17} />
            {notice.code === "SUBJECT_NOT_ALLOWED" ? (
              <span>
                此帳號尚未獲授權。你的帳號識別碼（sub）：<code>{notice.sub}</code>
              </span>
            ) : (
              <span>登入沒有完成，請再試一次。</span>
            )}
          </div>
        ) : null}

        <button
          className="button button--primary"
          type="button"
          onClick={() => window.location.assign("/api/auth/login")}
        >
          <LogIn aria-hidden="true" size={18} />
          <span>使用 PG72 ID 登入</span>
        </button>
      </section>
    </div>
  );
}
