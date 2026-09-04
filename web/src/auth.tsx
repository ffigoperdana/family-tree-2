import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type AuthRole = "admin" | "user";
export type LoginMode = AuthRole;

export interface AuthUser {
  id: string;
  username: string;
  role: AuthRole;
}

export interface AuthContextValue {
  enabled: boolean;
  loading: boolean;
  user?: AuthUser;
  csrfToken?: string;
  error?: string;
  login: (mode: LoginMode, username: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const unavailable = async () => {
  throw new Error("Authentication is unavailable in this local-only test context.");
};

const defaultContext: AuthContextValue = {
  enabled: false,
  loading: false,
  login: unavailable,
  logout: async () => undefined,
  refresh: async () => undefined
};

const AuthContext = createContext<AuthContextValue>(defaultContext);

const requestOptions: RequestInit = {
  credentials: "include",
  cache: "no-store",
  redirect: "error",
  referrerPolicy: "no-referrer"
};

const errorMessage = async (response: Response) => {
  const value = await response.json().catch(() => undefined) as { error?: { message?: unknown } } | undefined;
  return typeof value?.error?.message === "string"
    ? value.error.message
    : "The authentication request could not be completed.";
};

const parseSession = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The authentication service returned an invalid response.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.authenticated === false) return { user: undefined, csrfToken: undefined };
  const user = candidate.user;
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    throw new Error("The authentication service returned an invalid response.");
  }
  const record = user as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.username !== "string" ||
      (record.role !== "admin" && record.role !== "user") || typeof candidate.csrfToken !== "string") {
    throw new Error("The authentication service returned an invalid response.");
  }
  return {
    user: { id: record.id, username: record.username, role: record.role },
    csrfToken: candidate.csrfToken
  } satisfies Pick<AuthContextValue, "user" | "csrfToken">;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser>();
  const [csrfToken, setCsrfToken] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setError(undefined);
    try {
      const response = await fetch("/api/v1/auth/session", { method: "GET", ...requestOptions });
      if (!response.ok) throw new Error(await errorMessage(response));
      const parsed = parseSession(await response.json());
      setUser(parsed.user);
      setCsrfToken(parsed.csrfToken);
    } catch (reason) {
      setUser(undefined);
      setCsrfToken(undefined);
      setError(reason instanceof Error ? reason.message : "The authentication service is unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (mode: LoginMode, username: string, password: string) => {
    setError(undefined);
    const response = await fetch(`/api/v1/auth/login/${mode}`, {
      method: "POST",
      ...requestOptions,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    if (!response.ok) {
      const message = await errorMessage(response);
      setError(message);
      throw new Error(message);
    }
    const parsed = parseSession(await response.json());
    if (!parsed.user || !parsed.csrfToken) throw new Error("The authentication service returned an invalid response.");
    setUser(parsed.user);
    setCsrfToken(parsed.csrfToken);
    return parsed.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      if (csrfToken) {
        await fetch("/api/v1/auth/logout", {
          method: "POST",
          ...requestOptions,
          headers: { "x-csrf-token": csrfToken }
        });
      }
    } finally {
      setUser(undefined);
      setCsrfToken(undefined);
    }
  }, [csrfToken]);

  const value = useMemo<AuthContextValue>(() => ({
    enabled: true,
    loading,
    user,
    csrfToken,
    error,
    login,
    logout,
    refresh
  }), [csrfToken, error, loading, login, logout, refresh, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
