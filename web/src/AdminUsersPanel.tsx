import { Check, KeyRound, Pencil, Plus, ShieldCheck, UserRound, UserRoundX } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useAuth } from "./auth";
import type { Translator } from "./i18n";
import { PasswordField } from "./PasswordField";
import { ButtonLoader, ErrorNotice, SidePanel } from "./ui";

interface ManagedUser {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  createdAt: string;
}

const apiError = async (response: Response) => {
  const value = await response.json().catch(() => undefined) as { error?: { message?: unknown } } | undefined;
  return typeof value?.error?.message === "string" ? value.error.message : "The user request could not be completed.";
};

export function AdminUsersPanel({ onClose, t }: { onClose: () => void; t: Translator }) {
  const auth = useAuth();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [editing, setEditing] = useState<ManagedUser>();
  const [editUsername, setEditUsername] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const request = useCallback(async (path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown) => {
    const response = await fetch(path, {
      method,
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method !== "GET" && auth.csrfToken ? { "x-csrf-token": auth.csrfToken } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) throw new Error(await apiError(response));
    if (response.status === 204) return undefined;
    return await response.json() as { users?: ManagedUser[]; user?: ManagedUser };
  }, [auth.csrfToken]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await request("/api/v1/admin/users", "GET");
      setUsers(result?.users ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("adminUsersLoadError"));
    } finally {
      setLoading(false);
    }
  }, [request, t]);

  useEffect(() => {
    if (auth.user?.role === "admin" && auth.csrfToken) void loadUsers();
  }, [auth.csrfToken, auth.user?.role, loadUsers]);

  const createUser = async () => {
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await request("/api/v1/admin/users", "POST", { username: username.trim(), password });
      setUsername("");
      setPassword("");
      await loadUsers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("adminUsersSaveError"));
    } finally {
      setBusy(false);
    }
  };

  const saveUser = async () => {
    if (!editing || busy) return;
    const body = {
      ...(editUsername.trim() ? { username: editUsername.trim() } : {}),
      ...(editPassword ? { password: editPassword } : {})
    };
    if (!Object.keys(body).length) return;
    setBusy(true);
    setError(undefined);
    try {
      await request(`/api/v1/admin/users/${encodeURIComponent(editing.id)}`, "PATCH", body);
      setEditing(undefined);
      setEditPassword("");
      await loadUsers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("adminUsersSaveError"));
    } finally {
      setBusy(false);
    }
  };

  const toggleUser = async (user: ManagedUser) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await request(`/api/v1/admin/users/${encodeURIComponent(user.id)}`, "PATCH", { status: user.status === "active" ? "disabled" : "active" });
      await loadUsers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("adminUsersSaveError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidePanel closeLabel={t("close")} onClose={onClose} title={t("adminUsersTitle")}>
      <div className="admin-users-panel">
        <div className="admin-users-intro">
          <span className="panel-icon"><ShieldCheck aria-hidden="true" size={20} /></span>
          <p>{t("adminUsersIntro")}</p>
        </div>
        <section className="settings-card admin-create-user">
          <div className="settings-card-header"><Plus aria-hidden="true" size={20} /><div><strong>{t("adminCreateUser")}</strong><p className="settings-detail">{t("adminCreateUserDetail")}</p></div></div>
          <label className="field">{t("username")}<span className="auth-input-wrap"><UserRound aria-hidden="true" size={17} /><input autoComplete="off" maxLength={32} onChange={(event) => setUsername(event.target.value)} value={username} /></span></label>
          <PasswordField autoComplete="new-password" help={t("adminPasswordHelp")} hideLabel={t("hidePassword")} id="admin-new-user-password" label={t("password")} maxLength={128} onChange={setPassword} showLabel={t("showPassword")} value={password} />
          <button className="button primary full" disabled={busy || !username.trim() || !password} onClick={() => void createUser()} type="button">{busy ? <ButtonLoader size={17} /> : <Plus aria-hidden="true" size={17} />} {t("adminCreateUser")}</button>
        </section>
        <section className="admin-user-list" aria-labelledby="admin-user-list-title">
          <h3 id="admin-user-list-title">{t("adminUserList")}</h3>
          {loading ? <div className="admin-loading"><ButtonLoader /> {t("loading")}</div> : null}
          {!loading && users.map((user) => (
            <article className={`admin-user-row ${user.status === "disabled" ? "disabled" : ""}`} key={user.id}>
              <div className="admin-user-summary"><span className="panel-icon"><UserRound aria-hidden="true" size={18} /></span><div><strong>{user.username}</strong><small>{user.role === "admin" ? t("adminRole") : user.status === "active" ? t("activeUser") : t("disabledUser")}</small></div></div>
              {user.role === "admin" ? <span className="admin-fixed-badge"><ShieldCheck aria-hidden="true" size={14} /> {t("adminFixed")}</span> : <div className="admin-user-actions"><button aria-label={`${t("editUser")}: ${user.username}`} className="icon-button quiet small" onClick={() => { setEditing(user); setEditUsername(user.username); setEditPassword(""); }} type="button"><Pencil aria-hidden="true" size={16} /></button><button aria-label={`${user.status === "active" ? t("disableUser") : t("enableUser")}: ${user.username}`} className="icon-button quiet small" disabled={busy} onClick={() => void toggleUser(user)} type="button">{user.status === "active" ? <UserRoundX aria-hidden="true" size={16} /> : <Check aria-hidden="true" size={16} />}</button></div>}
              {editing?.id === user.id ? <div className="admin-user-edit"><label className="field">{t("username")}<input autoComplete="off" maxLength={32} onChange={(event) => setEditUsername(event.target.value)} value={editUsername} /></label><PasswordField autoComplete="new-password" help={t("adminResetPasswordHelp")} hideLabel={t("hidePassword")} id={`admin-reset-password-${user.id}`} label={t("adminResetPassword")} maxLength={128} onChange={setEditPassword} showLabel={t("showPassword")} value={editPassword} /><div className="settings-actions"><button className="button secondary" onClick={() => setEditing(undefined)} type="button">{t("cancel")}</button><button className="button primary" disabled={busy || !editUsername.trim() || !editPassword} onClick={() => void saveUser()} type="button">{busy ? <ButtonLoader /> : <KeyRound aria-hidden="true" size={16} />} {t("save")}</button></div></div> : null}
            </article>
          ))}
          {!loading && !users.length ? <p className="admin-empty">{t("adminNoUsers")}</p> : null}
        </section>
        <ErrorNotice message={error} />
      </div>
    </SidePanel>
  );
}
