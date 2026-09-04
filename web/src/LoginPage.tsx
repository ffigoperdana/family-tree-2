import { ArrowLeft, KeyRound, MessageCircle, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { useAuth, type LoginMode } from "./auth";
import { createTranslator } from "./i18n";
import { PasswordField } from "./PasswordField";

const accountRequestUrl = "https://wa.me/6281216195308?text=Halo%2C%20saya%20ingin%20meminta%20akun%20Soenarto%20Tree.";

export function LoginPage({ mode }: { mode: LoginMode }) {
  const auth = useAuth();
  const t = createTranslator("id");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!auth.loading && auth.user) window.location.replace("/");
  }, [auth.loading, auth.user]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password || pending) return;
    setError(undefined);
    setPending(true);
    void auth.login(mode, username.trim(), password)
      .then(() => window.location.replace("/"))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Login gagal. Silakan coba lagi."))
      .finally(() => setPending(false));
  };

  const isAdmin = mode === "admin";
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand">
          <img alt="" aria-hidden="true" className="brand-mark" height={192} src="/soenarto-tree-mark.svg" width={192} />
          <span>Soenarto Tree</span>
        </div>
        <div className="auth-heading">
          <span className="auth-icon"><ShieldCheck aria-hidden="true" size={23} /></span>
          <div>
            <h1 id="auth-title">{isAdmin ? "Login Admin" : "Login User"}</h1>
            <p>{isAdmin ? "Kelola silsilah utama keluarga Haji Soenarto." : "Masuk untuk membuka dan mengelola silsilah milikmu."}</p>
          </div>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <label className="field">
            Username
            <span className="auth-input-wrap"><UserRound aria-hidden="true" size={18} /><input autoComplete="username" autoFocus maxLength={32} onChange={(event) => setUsername(event.target.value)} value={username} /></span>
          </label>
          <PasswordField
            autoComplete="current-password"
            disabled={pending}
            error={error}
            hideLabel={t("hidePassword")}
            id="auth-password"
            label="Password"
            maxLength={128}
            onChange={setPassword}
            showLabel={t("showPassword")}
            value={password}
          />
          <button className="button primary full" disabled={pending || !username.trim() || !password} type="submit">
            <KeyRound aria-hidden="true" size={17} /> {pending ? "Memeriksa…" : "Login"}
          </button>
        </form>
        <div className="auth-links">
          {isAdmin ? (
            <a href="/login/user">Sudah punya akun user? Klik di sini</a>
          ) : (
            <a href="/login/admin"><ArrowLeft aria-hidden="true" size={15} /> Login admin</a>
          )}
          <a href={accountRequestUrl} rel="noopener noreferrer" target="_blank"><MessageCircle aria-hidden="true" size={15} /> Belum punya akun user? Klik di sini</a>
        </div>
        <a className="auth-back" href="/">Kembali ke silsilah utama</a>
      </section>
    </main>
  );
}
