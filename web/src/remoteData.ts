import type { AppData } from "./types";

export const CANONICAL_TREE_ID = "soenarto-canonical";

export interface RemoteTree {
  treeId: string;
  kind: "canonical" | "personal";
  ownerId?: string;
  title: string;
  revision: number;
  document: AppData;
}

export interface RemoteWorkspace {
  canonical?: RemoteTree;
  trees: RemoteTree[];
}

export class RemoteApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly currentRevision?: number
  ) {
    super("The family workspace request failed.");
    this.name = "RemoteApiError";
  }
}

const parseError = async (response: Response) => {
  const value = await response.json().catch(() => undefined) as {
    error?: { code?: unknown; currentRevision?: unknown }
  } | undefined;
  const error = value?.error;
  const currentRevision = error?.currentRevision;
  return new RemoteApiError(
    response.status,
    typeof error?.code === "string" ? error.code : "service_unavailable",
    typeof currentRevision === "number" && Number.isSafeInteger(currentRevision) ? currentRevision : undefined
  );
};

const parseTree = (value: unknown): RemoteTree => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RemoteApiError(502, "invalid_response");
  const candidate = value as Record<string, unknown>;
  const treeId = candidate.treeId;
  const kind = candidate.kind;
  const title = candidate.title;
  const revision = candidate.revision;
  if (typeof treeId !== "string" ||
      (kind !== "canonical" && kind !== "personal") ||
      typeof title !== "string" || typeof revision !== "number" || !Number.isSafeInteger(revision) ||
      !candidate.document || typeof candidate.document !== "object" || Array.isArray(candidate.document)) {
    throw new RemoteApiError(502, "invalid_response");
  }
  return {
    treeId,
    kind,
    ownerId: typeof candidate.ownerId === "string" ? candidate.ownerId : undefined,
    title,
    revision,
    document: candidate.document as AppData
  };
};

const request = async <T>(path: string, init: RequestInit = {}) => {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer"
  });
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
};

export async function fetchCanonicalTree(): Promise<RemoteTree> {
  return parseTree(await request<unknown>("/api/v1/public/canonical-tree"));
}

export async function fetchWorkspace(): Promise<RemoteWorkspace> {
  const value = await request<unknown>("/api/v1/workspace");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RemoteApiError(502, "invalid_response");
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.trees)) throw new RemoteApiError(502, "invalid_response");
  return {
    canonical: candidate.canonical === undefined ? undefined : parseTree(candidate.canonical),
    trees: candidate.trees.map(parseTree)
  };
}

const mutation = (path: string, method: "POST" | "PUT" | "DELETE", csrfToken: string, body?: unknown) =>
  request<unknown>(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

export async function createRemoteTree(document: AppData, csrfToken: string): Promise<RemoteTree> {
  return parseTree(await mutation("/api/v1/trees", "POST", csrfToken, { treeId: document.trees[0]?.id, document }));
}

export async function updateRemoteTree(
  treeId: string,
  document: AppData,
  baseRevision: number,
  csrfToken: string
): Promise<RemoteTree> {
  return parseTree(await mutation(`/api/v1/trees/${encodeURIComponent(treeId)}`, "PUT", csrfToken, { document, baseRevision }));
}

export async function deleteRemoteTree(treeId: string, csrfToken: string): Promise<void> {
  await mutation(`/api/v1/trees/${encodeURIComponent(treeId)}`, "DELETE", csrfToken);
}
