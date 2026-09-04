import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import argon2 from "argon2";
import pg from "pg";

const { Pool } = pg;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.resolve(process.env.STATIC_ROOT ?? path.join(ROOT, "..", "web", "dist"));
const NODE_ENV = process.env.NODE_ENV ?? "development";
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const configuredDatabaseUrl = process.env.DATABASE_URL?.trim();
const DATABASE_URL = configuredDatabaseUrl ?? (NODE_ENV === "production" ? "" : "postgres://soenarto:soenarto@db:5432/soenarto");
const SESSION_SECRET = process.env.SESSION_SECRET ?? (NODE_ENV === "production" ? "" : "local-development-session-secret-change-me");
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1" || (NODE_ENV === "production" && process.env.COOKIE_SECURE !== "0");
const SESSION_COOKIE = COOKIE_SECURE ? "__Host-soenarto_session" : "soenarto_session";
const CSRF_COOKIE = "soenarto_csrf";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 34 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_PEOPLE = 25_000;
const MAX_RELATIONSHIPS = 50_000;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_SHARE_ENVELOPE_BYTES = 32 * 1024 * 1024;
const SHARE_ENVELOPE_VERSION = "HTGSHR02";
const SHARE_GENERATION_PATTERN = /^[1-9][0-9]{0,30}$/u;
const SHARE_UPLOAD_TOKEN_HEADER = "x-soenarto-upload-token";
const SHARE_RATE_WINDOW_MS = 60 * 1000;
const SHARE_RATE_LIMIT = 60;
const CANONICAL_TREE_ID = process.env.CANONICAL_TREE_ID ?? "soenarto-canonical";
const CANONICAL_TREE_TITLE = process.env.CANONICAL_TREE_TITLE ?? "Keluarga Haji Soenarto";
const configuredPublicOrigin = process.env.PUBLIC_APP_ORIGIN?.trim();
let PUBLIC_APP_ORIGIN;
if (configuredPublicOrigin) {
  try {
    const parsed = new URL(configuredPublicOrigin);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported_protocol");
    PUBLIC_APP_ORIGIN = parsed.origin;
  } catch {
    throw new Error("PUBLIC_APP_ORIGIN must be a valid http(s) origin.");
  }
}

if (NODE_ENV === "production" && SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must be at least 32 characters in production.");
}

if (NODE_ENV === "production" && !DATABASE_URL) {
  throw new Error("DATABASE_URL must be configured in production.");
}

if (NODE_ENV === "production" && PUBLIC_APP_ORIGIN && !PUBLIC_APP_ORIGIN.startsWith("https://")) {
  throw new Error("PUBLIC_APP_ORIGIN must use HTTPS in production.");
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
let dummyPasswordHash;

const schema = `
CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_admin_idx
  ON app_users (role) WHERE role = 'admin' AND status = 'active';

CREATE TABLE IF NOT EXISTS app_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS app_sessions_expiry_idx ON app_sessions (expires_at);

CREATE TABLE IF NOT EXISTS family_trees (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('canonical', 'personal')),
  owner_id TEXT REFERENCES app_users(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  document JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT family_tree_owner_kind CHECK (
    (kind = 'canonical' AND owner_id IS NULL) OR
    (kind = 'personal' AND owner_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS one_canonical_family_tree_idx
  ON family_trees (kind) WHERE kind = 'canonical';
CREATE INDEX IF NOT EXISTS family_trees_owner_idx ON family_trees (owner_id, updated_at DESC);

CREATE OR REPLACE FUNCTION protect_canonical_family_tree() RETURNS trigger AS $$
BEGIN
  IF OLD.kind = 'canonical' THEN
    IF TG_OP = 'DELETE' OR NEW.kind <> 'canonical' OR NEW.owner_id IS NOT NULL OR NEW.id <> OLD.id THEN
      RAISE EXCEPTION 'canonical_tree_protected';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS protect_canonical_family_tree_trigger ON family_trees;
CREATE TRIGGER protect_canonical_family_tree_trigger
  BEFORE DELETE OR UPDATE ON family_trees
  FOR EACH ROW EXECUTE FUNCTION protect_canonical_family_tree();

CREATE TABLE IF NOT EXISTS managed_shares (
  share_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  deletion_token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'active', 'revoked')),
  envelope_version TEXT NOT NULL DEFAULT 'HTGSHR02',
  ciphertext_bytes INTEGER,
  envelope BYTEA,
  object_generation TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE managed_shares ADD COLUMN IF NOT EXISTS envelope_version TEXT NOT NULL DEFAULT 'HTGSHR02';
ALTER TABLE managed_shares ADD COLUMN IF NOT EXISTS ciphertext_bytes INTEGER;
ALTER TABLE managed_shares ADD COLUMN IF NOT EXISTS envelope BYTEA;
ALTER TABLE managed_shares ADD COLUMN IF NOT EXISTS object_generation TEXT;
ALTER TABLE managed_shares ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS managed_shares_owner_idx ON managed_shares (owner_id, created_at DESC);
`;

const now = () => new Date().toISOString();
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value, maximum = 16_384) => typeof value === "string" && value.length <= maximum;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const shareIdPattern = /^[A-Za-z0-9_-]{22}$/u;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const usernamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/u;

const normalizeUsername = (value) => value.trim().toLowerCase();

const randomToken = () => randomBytes(32).toString("base64url");

const secretHash = (value) => createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");

const equalSecret = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const cookieValue = (request, name) => {
  const cookies = request.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return undefined;
};

const cookieHeader = (name, value, options = {}) => {
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${options.maxAge ?? Math.floor(SESSION_TTL_MS / 1_000)}`,
    "SameSite=Lax"
  ];
  if (COOKIE_SECURE) attributes.push("Secure");
  if (options.httpOnly) attributes.push("HttpOnly");
  return attributes.join("; ");
};

const clearCookieHeader = (name, httpOnly) => cookieHeader(name, "", { maxAge: 0, httpOnly });

const securityHeaders = (response) => {
  response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; media-src 'self' blob:");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), browsing-topics=()");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (COOKIE_SECURE) response.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
};

const sendJson = (response, status, value, extraHeaders = {}) => {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  for (const [key, value] of Object.entries(extraHeaders)) response.setHeader(key, value);
  response.end(body);
};

const sendNoContent = (response, status = 204) => {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.end();
};

const errorResponse = (response, status, code, message, extraHeaders) =>
  sendJson(response, status, { error: { code, message } }, extraHeaders);

const readBody = async (request, maximumBytes = MAX_BODY_BYTES) => {
  const length = Number.parseInt(String(request.headers["content-length"] ?? "0"), 10);
  if (Number.isFinite(length) && length > maximumBytes) {
    const error = new Error("request_too_large");
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maximumBytes) {
      const error = new Error("request_too_large");
      error.status = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  if (!total) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.status = 400;
    throw error;
  }
};

const readBinaryBody = async (request, maximumBytes = MAX_SHARE_ENVELOPE_BYTES) => {
  const contentLengthHeader = request.headers["content-length"];
  const length = contentLengthHeader === undefined ? undefined : Number.parseInt(String(contentLengthHeader), 10);
  if (length !== undefined && (!Number.isFinite(length) || length < 1 || length > maximumBytes)) {
    const error = new Error("request_too_large");
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maximumBytes) {
      const error = new Error("request_too_large");
      error.status = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  if (!total) {
    const error = new Error("empty_body");
    error.status = 400;
    throw error;
  }
  return Buffer.concat(chunks);
};

const publicUser = (row) => ({
  id: row.id,
  username: row.username,
  role: row.role,
  status: row.status,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString()
});

const rowTree = (row) => ({
  treeId: row.id,
  kind: row.kind,
  ownerId: row.owner_id ?? undefined,
  title: row.title,
  revision: Number(row.revision),
  document: row.document
});

const canonicalTemplate = (timestamp = now()) => ({
  version: 1,
  trees: [{
    id: CANONICAL_TREE_ID,
    title: CANONICAL_TREE_TITLE,
    createdAt: timestamp,
    updatedAt: timestamp,
    kind: "canonical"
  }],
  people: [],
  relationships: [],
  selectedTreeId: CANONICAL_TREE_ID,
  language: "id",
  relationshipLanguage: "id",
  relationshipTerminology: "id",
  viewports: {}
});

const personalTemplate = (treeId, title, timestamp = now()) => ({
  version: 1,
  trees: [{
    id: treeId,
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    kind: "personal"
  }],
  people: [],
  relationships: [],
  selectedTreeId: treeId,
  language: "id",
  relationshipLanguage: "id",
  relationshipTerminology: "id",
  viewports: {}
});

const validateTreeDocument = (value, treeId) => {
  if (!isObject(value) || value.version !== 1 || !["en", "id"].includes(value.language) ||
      !Array.isArray(value.trees) || value.trees.length !== 1 || !Array.isArray(value.people) ||
      !Array.isArray(value.relationships) || !isObject(value.viewports)) {
    return "invalid_data";
  }
  const serializedSize = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (serializedSize > MAX_DOCUMENT_BYTES) return "document_too_large";
  if (value.trees[0]?.id !== treeId || !isString(value.trees[0].title, 160)) return "invalid_data";
  if (value.people.length > MAX_PEOPLE || value.relationships.length > MAX_RELATIONSHIPS) return "invalid_data";
  const people = new Set();
  for (const person of value.people) {
    if (!isObject(person) || !isString(person.id, 128) || !idPattern.test(person.id) || people.has(person.id) ||
        person.treeId !== treeId || !isString(person.displayName, 512) || !person.displayName.trim() ||
        !["female", "male", "unspecified"].includes(person.gender) || !isString(person.createdAt, 64) ||
        (person.photoDataUrl !== undefined && !validPhotoDataUrl(person.photoDataUrl))) {
      return "invalid_data";
    }
    people.add(person.id);
  }
  const relationships = new Set();
  for (const relationship of value.relationships) {
    if (!isObject(relationship) || !isString(relationship.id, 128) || !idPattern.test(relationship.id) ||
        relationships.has(relationship.id) || relationship.treeId !== treeId ||
        !people.has(relationship.fromPersonId) || !people.has(relationship.toPersonId) ||
        relationship.fromPersonId === relationship.toPersonId || !isString(relationship.createdAt, 64) ||
        !["parent", "partner", "sibling"].includes(relationship.kind) || !isString(relationship.subtype, 64)) {
      return "invalid_data";
    }
    relationships.add(relationship.id);
  }
  return undefined;
};

const normalizeDocument = (document, tree, timestamp) => ({
  ...document,
  trees: [{
    ...document.trees[0],
    id: tree.id,
    title: tree.kind === "canonical" ? CANONICAL_TREE_TITLE : tree.title,
    createdAt: new Date(tree.created_at).toISOString(),
    updatedAt: timestamp,
    kind: tree.kind,
    ...(tree.owner_id ? { ownerId: tree.owner_id } : {})
  }],
  selectedTreeId: tree.id
});

const photoDataPattern = /^data:(image\/(?:jpeg|png|webp|gif|heic));base64,([A-Za-z0-9+/]+={0,2})$/iu;
const startsWithBytes = (bytes, signature) => signature.every((value, index) => bytes[index] === value);
const validPhotoDataUrl = (value) => {
  if (typeof value !== "string" || value.length > 14 * 1024 * 1024) return false;
  const match = photoDataPattern.exec(value);
  if (!match) return false;
  const encoded = match[2];
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.byteLength || bytes.byteLength > MAX_PHOTO_BYTES) return false;
  const mimeType = match[1].toLowerCase();
  if (mimeType === "image/jpeg" && !startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return false;
  if (mimeType === "image/png" && !startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return false;
  if (mimeType === "image/gif" && !["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return false;
  if (mimeType === "image/webp" && (bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP")) return false;
  if (mimeType === "image/heic" && (bytes.subarray(4, 8).toString("ascii") !== "ftyp" || !["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(bytes.subarray(8, 12).toString("ascii")))) return false;
  const canonical = bytes.toString("base64").replace(/=+$/u, "");
  return canonical === encoded.replace(/=+$/u, "");
};

const requestHost = (request) => String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").split(",")[0].trim().toLowerCase();

const requestOrigin = (request) => {
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",", 1)[0]
    .trim()
    .toLowerCase();
  const protocol = forwardedProtocol === "https" || (!forwardedProtocol && COOKIE_SECURE) ? "https" : "http";
  const host = requestHost(request);
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return undefined;
  }
};

const isSameOrigin = (request) => {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.origin.toLowerCase() === requestOrigin(request)?.toLowerCase();
  } catch {
    return false;
  }
};

const loadSession = async (request) => {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || token.length < 32) return undefined;
  const result = await pool.query(
    `SELECT s.*, u.username, u.role, u.status
       FROM app_sessions s
       JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.status = 'active'`,
    [secretHash(token)]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return { ...row, token, csrfToken: cookieValue(request, CSRF_COOKIE) };
};

const requireSession = async (request, response) => {
  const session = await loadSession(request);
  if (!session) {
    errorResponse(response, 401, "unauthenticated", "Sign in is required.");
    return undefined;
  }
  return session;
};

const requireCsrf = (request, response, session) => {
  if (!isSameOrigin(request)) {
    errorResponse(response, 403, "forbidden", "The request origin is not allowed.");
    return false;
  }
  const supplied = request.headers["x-csrf-token"];
  if (typeof supplied !== "string" || !tokenPattern.test(supplied) || !equalSecret(secretHash(supplied), session.csrf_hash)) {
    errorResponse(response, 403, "csrf_failed", "The request could not be verified.");
    return false;
  }
  return true;
};

const sessionUser = (session) => ({ id: session.user_id, username: session.username, role: session.role });

const createSession = async (request, response, user) => {
  const token = randomToken();
  const csrfToken = randomToken();
  const timestamp = new Date();
  const expires = new Date(timestamp.getTime() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO app_sessions (id, token_hash, csrf_hash, user_id, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $5, $6)`,
    [randomUUID(), secretHash(token), secretHash(csrfToken), user.id, timestamp.toISOString(), expires.toISOString()]
  );
  response.setHeader("Set-Cookie", [
    cookieHeader(SESSION_COOKIE, token, { httpOnly: true }),
    cookieHeader(CSRF_COOKIE, csrfToken)
  ]);
  return { token, csrfToken, expires };
};

const rotateCsrfCookie = async (response, session) => {
  const csrfToken = randomToken();
  await pool.query("UPDATE app_sessions SET csrf_hash = $1 WHERE id = $2", [secretHash(csrfToken), session.id]);
  const existing = response.getHeader("Set-Cookie");
  const values = Array.isArray(existing) ? existing : existing ? [existing] : [];
  response.setHeader("Set-Cookie", [...values, cookieHeader(CSRF_COOKIE, csrfToken)]);
  session.csrfToken = csrfToken;
  session.csrf_hash = secretHash(csrfToken);
  return csrfToken;
};

const touchSession = (session) => pool.query("UPDATE app_sessions SET last_seen_at = NOW() WHERE id = $1", [session.id]).catch(() => undefined);

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const rateLimit = new Map();
const ipRateLimit = new Map();
const loginRateKey = (request, username, role) => `${request.socket.remoteAddress ?? "unknown"}|${role}|${normalizeUsername(username)}`;
const loginIpRateKey = (request) => request.socket.remoteAddress ?? "unknown";

const liveRateEntry = (entries, key, timestamp) => {
  const entry = entries.get(key);
  if (entry && entry.blockedUntil > 0 && entry.blockedUntil <= timestamp) {
    entries.delete(key);
    return undefined;
  }
  return entry;
};

const loginAllowed = (key, ipKey) => {
  const timestamp = Date.now();
  const current = liveRateEntry(rateLimit, key, timestamp);
  const ipCurrent = liveRateEntry(ipRateLimit, ipKey, timestamp);
  return (!current || current.blockedUntil <= timestamp) && (!ipCurrent || ipCurrent.blockedUntil <= timestamp);
};

const registerLoginFailure = (key, ipKey) => {
  const timestamp = Date.now();
  const current = liveRateEntry(rateLimit, key, timestamp) ?? { failures: 0, blockedUntil: 0 };
  current.failures += 1;
  if (current.failures >= 5) current.blockedUntil = timestamp + LOGIN_WINDOW_MS;
  rateLimit.set(key, current);

  const ipCurrent = liveRateEntry(ipRateLimit, ipKey, timestamp) ?? { failures: 0, blockedUntil: 0 };
  ipCurrent.failures += 1;
  if (ipCurrent.failures >= 30) ipCurrent.blockedUntil = timestamp + LOGIN_WINDOW_MS;
  ipRateLimit.set(ipKey, ipCurrent);
  return { blockedUntil: Math.max(current.blockedUntil, ipCurrent.blockedUntil) };
};

const clearLoginFailures = (key) => rateLimit.delete(key);

const canReadTree = (session, tree) => tree.kind === "canonical" || Boolean(session && tree.owner_id === session.user_id);
const canWriteTree = (session, tree) => Boolean(session && ((tree.kind === "canonical" && session.role === "admin") || (tree.kind === "personal" && tree.owner_id === session.user_id)));

const getTree = async (treeId) => {
  const result = await pool.query("SELECT * FROM family_trees WHERE id = $1", [treeId]);
  return result.rows[0];
};

const getCanonical = async () => {
  const result = await pool.query("SELECT * FROM family_trees WHERE kind = 'canonical' LIMIT 1");
  return result.rows[0];
};

const validateTreeId = (treeId) => typeof treeId === "string" && idPattern.test(treeId);

const validatePassword = (password) => typeof password === "string" && password.length >= 12 && password.length <= 128;

const validateUsername = (username) => typeof username === "string" && usernamePattern.test(username);

const initialize = async () => {
  await pool.query(schema);
  dummyPasswordHash = await argon2.hash(randomToken(), {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1
  });
  const canonical = await getCanonical();
  if (!canonical) {
    const timestamp = now();
    await pool.query(
      `INSERT INTO family_trees (id, kind, owner_id, title, document, revision, created_at, updated_at)
       VALUES ($1, 'canonical', NULL, $2, $3::jsonb, 0, $4, $4)`,
      [CANONICAL_TREE_ID, CANONICAL_TREE_TITLE, JSON.stringify(canonicalTemplate(timestamp)), timestamp]
    );
  }
  const bootstrapUsername = process.env.BOOTSTRAP_ADMIN_USERNAME;
  const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const adminCount = await pool.query("SELECT COUNT(*)::int AS count FROM app_users WHERE role = 'admin' AND status = 'active'");
  if (adminCount.rows[0].count === 0 && bootstrapUsername && bootstrapPassword) {
    if (!validateUsername(bootstrapUsername) || !validatePassword(bootstrapPassword)) {
      throw new Error("BOOTSTRAP_ADMIN_USERNAME or BOOTSTRAP_ADMIN_PASSWORD does not meet the required format.");
    }
    const timestamp = now();
    const hash = await argon2.hash(bootstrapPassword, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1
    });
    await pool.query(
      `INSERT INTO app_users (id, username, username_normalized, password_hash, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'admin', 'active', $5, $5)
       ON CONFLICT (username_normalized) DO NOTHING`,
      [randomUUID(), bootstrapUsername.trim(), normalizeUsername(bootstrapUsername), hash, timestamp]
    );
  }
};

const shareRecord = async (shareId, session, deletionToken) => {
  if (!shareIdPattern.test(shareId) || !session) return undefined;
  const result = await pool.query("SELECT * FROM managed_shares WHERE share_id = $1 AND owner_id = $2", [shareId, session.user_id]);
  const row = result.rows[0];
  if (!row || (deletionToken && !equalSecret(secretHash(deletionToken), row.deletion_token_hash))) return undefined;
  return row;
};

const shareRate = new Map();
const shareRateAllowed = (request, shareId) => {
  const key = `${request.socket.remoteAddress ?? "unknown"}|${shareId}`;
  const timestamp = Date.now();
  const current = shareRate.get(key);
  if (!current || timestamp - current.windowStartedAt >= SHARE_RATE_WINDOW_MS) {
    shareRate.set(key, { windowStartedAt: timestamp, requests: 1 });
    return true;
  }
  if (current.requests >= SHARE_RATE_LIMIT) return false;
  current.requests += 1;
  return true;
};

const shareExpired = (row) => row.expires_at && new Date(row.expires_at).getTime() <= Date.now();

const shareById = async (shareId) => {
  if (!shareIdPattern.test(shareId)) return undefined;
  const result = await pool.query("SELECT * FROM managed_shares WHERE share_id = $1", [shareId]);
  return result.rows[0];
};

const cleanupExpiredShares = () => pool.query(
  "DELETE FROM managed_shares WHERE expires_at IS NOT NULL AND expires_at < NOW() - INTERVAL '7 days'"
).catch(() => undefined);

const handleShareAllocation = async (request, response, session, body) => {
  if (!requireCsrf(request, response, session)) return;
  if (!isObject(body) || body.envelopeVersion !== SHARE_ENVELOPE_VERSION ||
      !Number.isSafeInteger(body.ciphertextBytes) || body.ciphertextBytes < SHARE_ENVELOPE_VERSION.length + 16 + 12 + 16 || body.ciphertextBytes > MAX_SHARE_ENVELOPE_BYTES ||
      ![7, 30, 90].includes(body.expiryDays)) {
    errorResponse(response, 400, "invalid_request", "The share request is invalid.");
    return;
  }
  const shareId = randomBytes(16).toString("base64url");
  const deletionToken = randomToken();
  const timestamp = new Date();
  const expires = new Date(timestamp.getTime() + body.expiryDays * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO managed_shares
      (share_id, owner_id, deletion_token_hash, status, envelope_version, ciphertext_bytes, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'reserved', $4, $5, $6, $7, $7)`,
    [shareId, session.user_id, secretHash(deletionToken), SHARE_ENVELOPE_VERSION, body.ciphertextBytes, expires.toISOString(), timestamp.toISOString()]
  );
  sendJson(response, 201, {
    shareId,
    deletionToken,
    uploadUrl: `${requestPublicOrigin(request)}/api/v1/share-uploads/${shareId}/blob`,
    requiredHeaders: {
      "content-type": "application/octet-stream",
      [SHARE_UPLOAD_TOKEN_HEADER]: deletionToken
    },
    shareExpiresAt: expires.toISOString()
  });
};

const handleShareUpload = async (request, response, shareId) => {
  if (!isSameOrigin(request)) {
    errorResponse(response, 403, "forbidden", "The request origin is not allowed.");
    return;
  }
  const uploadToken = request.headers[SHARE_UPLOAD_TOKEN_HEADER];
  if (typeof uploadToken !== "string" || !tokenPattern.test(uploadToken)) {
    errorResponse(response, 403, "forbidden", "The upload is not allowed.");
    return;
  }
  const record = await shareById(shareId);
  if (!record || !equalSecret(secretHash(uploadToken), record.deletion_token_hash)) {
    errorResponse(response, 403, "forbidden", "The upload is not allowed.");
    return;
  }
  if (shareExpired(record)) {
    errorResponse(response, 410, "expired", "This encrypted share has expired.");
    return;
  }
  if (record.status !== "reserved" || record.envelope) {
    errorResponse(response, 409, "already_exists", "This encrypted share has already been uploaded.");
    return;
  }
  if (String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/octet-stream") {
    errorResponse(response, 415, "invalid_request", "The encrypted upload has an invalid content type.");
    return;
  }
  let envelope;
  try {
    envelope = await readBinaryBody(request);
  } catch (error) {
    errorResponse(response, error.status ?? 400, "invalid_request", "The encrypted upload is invalid.");
    return;
  }
  if (envelope.byteLength !== Number(record.ciphertext_bytes) || envelope.subarray(0, SHARE_ENVELOPE_VERSION.length).toString("ascii") !== SHARE_ENVELOPE_VERSION) {
    errorResponse(response, 400, "invalid_request", "The encrypted upload is invalid.");
    return;
  }
  const generation = String(Date.now());
  const updated = await pool.query(
    `UPDATE managed_shares
        SET envelope = $1, object_generation = $2, updated_at = NOW()
      WHERE share_id = $3 AND status = 'reserved' AND envelope IS NULL
    RETURNING share_id`,
    [envelope, generation, shareId]
  );
  if (!updated.rows[0]) {
    errorResponse(response, 409, "already_exists", "This encrypted share has already been uploaded.");
    return;
  }
  response.setHeader("x-soenarto-generation", generation);
  response.setHeader("x-goog-generation", generation);
  sendNoContent(response);
};

const handleShareComplete = async (request, response, session, body) => {
  if (!requireCsrf(request, response, session)) return;
  if (!isObject(body) || !shareIdPattern.test(String(body.shareId ?? "")) ||
      !tokenPattern.test(String(body.deletionToken ?? "")) || !/^[1-9][0-9]{0,30}$/u.test(String(body.objectGeneration ?? ""))) {
    errorResponse(response, 400, "invalid_request", "The share request is invalid.");
    return;
  }
  const record = await shareRecord(body.shareId, session, body.deletionToken);
  if (!record) {
    errorResponse(response, 403, "forbidden", "The share request is not allowed.");
    return;
  }
  if (shareExpired(record)) {
    errorResponse(response, 410, "expired", "This encrypted share has expired.");
    return;
  }
  if (!record.envelope || record.object_generation !== body.objectGeneration) {
    errorResponse(response, 409, "not_ready", "The encrypted share upload is not ready.");
    return;
  }
  if (record.status === "active") {
    sendJson(response, 200, { status: "active" });
    return;
  }
  if (record.status !== "reserved") {
    errorResponse(response, 403, "forbidden", "The share request is not allowed.");
    return;
  }
  await pool.query("UPDATE managed_shares SET status = 'active', updated_at = NOW() WHERE share_id = $1 AND status = 'reserved'", [body.shareId]);
  sendJson(response, 200, { status: "active" });
};

const handleShareRevocation = async (request, response, session, body) => {
  if (!requireCsrf(request, response, session)) return;
  if (!isObject(body) || !shareIdPattern.test(String(body.shareId ?? "")) || !tokenPattern.test(String(body.deletionToken ?? ""))) {
    errorResponse(response, 400, "invalid_request", "The share request is invalid.");
    return;
  }
  const record = await shareRecord(body.shareId, session, body.deletionToken);
  if (!record) {
    errorResponse(response, 403, "forbidden", "The share request is not allowed.");
    return;
  }
  await pool.query(
    "UPDATE managed_shares SET status = 'revoked', envelope = NULL, ciphertext_bytes = NULL, object_generation = NULL, updated_at = NOW() WHERE share_id = $1 AND owner_id = $2",
    [body.shareId, session.user_id]
  );
  sendJson(response, 200, { status: "revoked" });
};

const handleShareDownloadGrant = async (request, response, body) => {
  const shareId = String(body?.shareId ?? "");
  if (!shareIdPattern.test(shareId)) {
    errorResponse(response, 400, "invalid_request", "The share request is invalid.");
    return;
  }
  if (!shareRateAllowed(request, shareId)) {
    errorResponse(response, 429, "rate_limited", "Too many sharing requests. Please wait and try again.", { "Retry-After": "60" });
    return;
  }
  const record = await shareById(shareId);
  if (!record) {
    errorResponse(response, 404, "not_found", "This encrypted share could not be found.");
    return;
  }
  if (record.status === "revoked") {
    errorResponse(response, 410, "revoked", "This encrypted share was revoked.");
    return;
  }
  if (!record.envelope || record.status === "reserved") {
    errorResponse(response, 404, "not_found", "This encrypted share could not be found.");
    return;
  }
  if (shareExpired(record)) {
    errorResponse(response, 410, "expired", "This encrypted share has expired.");
    return;
  }
  sendJson(response, 200, {
    downloadUrl: `${requestPublicOrigin(request)}/api/v1/share-downloads/${shareId}/blob`,
    envelopeVersion: record.envelope_version,
    ciphertextBytes: Number(record.ciphertext_bytes),
    shareExpiresAt: new Date(record.expires_at).toISOString()
  });
};

const handleShareDownload = async (request, response, shareId) => {
  if (!shareRateAllowed(request, shareId)) {
    errorResponse(response, 429, "rate_limited", "Too many sharing requests. Please wait and try again.", { "Retry-After": "60" });
    return;
  }
  const record = await shareById(shareId);
  if (!record) {
    errorResponse(response, 404, "not_found", "This encrypted share could not be found.");
    return;
  }
  if (record.status === "revoked") {
    errorResponse(response, 410, "revoked", "This encrypted share was revoked.");
    return;
  }
  if (!record.envelope || record.status === "reserved") {
    errorResponse(response, 404, "not_found", "This encrypted share could not be found.");
    return;
  }
  if (shareExpired(record)) {
    errorResponse(response, 410, "expired", "This encrypted share has expired.");
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/octet-stream");
  response.setHeader("Content-Length", String(record.envelope.byteLength));
  response.setHeader("Content-Disposition", "attachment; filename=soenarto-share.bin");
  response.setHeader("Cache-Control", "no-store");
  response.end(record.envelope);
};

const adminRequired = async (request, response) => {
  const session = await requireSession(request, response);
  if (!session) return undefined;
  if (session.role !== "admin") {
    errorResponse(response, 403, "forbidden", "Administrator access is required.");
    return undefined;
  }
  return session;
};

const handleApi = async (request, response, pathname, segments) => {
  if (request.method === "GET" && pathname === "/api/v1/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && pathname === "/api/v1/ready") {
    try {
      await pool.query("SELECT 1");
      sendJson(response, 200, { status: "ready" });
    } catch {
      errorResponse(response, 503, "service_unavailable", "The service is not ready.");
    }
    return;
  }
  if (pathname === "/api/v1/auth/session" && request.method === "GET") {
    const session = await loadSession(request);
    if (!session) {
      sendJson(response, 200, { authenticated: false });
      return;
    }
    const csrfToken = session.csrfToken && tokenPattern.test(session.csrfToken) && equalSecret(secretHash(session.csrfToken), session.csrf_hash)
      ? session.csrfToken
      : await rotateCsrfCookie(response, session);
    void touchSession(session);
    sendJson(response, 200, { authenticated: true, user: sessionUser(session), csrfToken, expiresAt: new Date(session.expires_at).toISOString() });
    return;
  }
  if (pathname === "/api/v1/auth/login/admin" || pathname === "/api/v1/auth/login/user") {
    if (request.method !== "POST") {
      errorResponse(response, 405, "method_not_allowed", "Method not allowed.");
      return;
    }
    if (!isSameOrigin(request)) {
      errorResponse(response, 403, "forbidden", "The request origin is not allowed.");
      return;
    }
    let body;
    try {
      body = await readBody(request, 16 * 1024);
    } catch (error) {
      errorResponse(response, error.status ?? 400, error.message === "request_too_large" ? "request_too_large" : "invalid_request", "The login request is invalid.");
      return;
    }
    const role = pathname.endsWith("/admin") ? "admin" : "user";
    const username = typeof body?.username === "string" ? body.username : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const key = loginRateKey(request, username, role);
    const ipKey = loginIpRateKey(request);
    if (!loginAllowed(key, ipKey)) {
      errorResponse(response, 429, "rate_limited", "Too many login attempts. Try again later.", { "Retry-After": "900" });
      return;
    }
    const result = await pool.query("SELECT * FROM app_users WHERE username_normalized = $1 LIMIT 1", [normalizeUsername(username)]);
    const row = result.rows[0];
    let valid = false;
    try {
      valid = await argon2.verify(row?.password_hash ?? dummyPasswordHash, password);
    } catch {
      valid = false;
    }
    if (!row || row.status !== "active" || row.role !== role || !valid) {
      const failure = registerLoginFailure(key, ipKey);
      if (failure.blockedUntil > Date.now()) {
        errorResponse(response, 429, "rate_limited", "Too many login attempts. Try again later.", { "Retry-After": "900" });
      } else {
        errorResponse(response, 401, "invalid_credentials", "Username or password is incorrect.");
      }
      return;
    }
    clearLoginFailures(key);
    await pool.query("DELETE FROM app_sessions WHERE user_id = $1", [row.id]);
    const createdSession = await createSession(request, response, row);
    sendJson(response, 200, {
      authenticated: true,
      user: publicUser(row),
      csrfToken: createdSession.csrfToken,
      expiresAt: createdSession.expires.toISOString()
    });
    return;
  }
  if (pathname === "/api/v1/auth/logout" && request.method === "POST") {
    const session = await loadSession(request);
    if (session && !requireCsrf(request, response, session)) return;
    if (session) await pool.query("DELETE FROM app_sessions WHERE id = $1", [session.id]);
    response.setHeader("Set-Cookie", [clearCookieHeader(SESSION_COOKIE, true), clearCookieHeader(CSRF_COOKIE, false)]);
    sendNoContent(response);
    return;
  }
  if (request.method === "GET" && pathname === "/api/v1/public/canonical-tree") {
    const canonical = await getCanonical();
    if (!canonical) {
      errorResponse(response, 503, "service_unavailable", "The canonical family tree is unavailable.");
      return;
    }
    sendJson(response, 200, { ...rowTree(canonical), document: normalizeDocument(canonical.document, canonical, new Date(canonical.updated_at).toISOString()) });
    return;
  }
  if (request.method === "GET" && pathname === "/api/v1/workspace") {
    const session = await requireSession(request, response);
    if (!session) return;
    const canonical = await getCanonical();
    const result = await pool.query("SELECT * FROM family_trees WHERE kind = 'personal' AND owner_id = $1 ORDER BY updated_at DESC", [session.user_id]);
    sendJson(response, 200, {
      user: sessionUser(session),
      canonical: canonical ? { ...rowTree(canonical), document: normalizeDocument(canonical.document, canonical, new Date(canonical.updated_at).toISOString()) } : undefined,
      trees: result.rows.map((row) => ({ ...rowTree(row), document: normalizeDocument(row.document, row, new Date(row.updated_at).toISOString()) }))
    });
    return;
  }
  if (segments[2] === "trees" && segments.length === 4) {
    const treeId = segments[3];
    if (!validateTreeId(treeId)) {
      errorResponse(response, 400, "invalid_request", "The tree identifier is invalid.");
      return;
    }
    const session = await requireSession(request, response);
    if (!session) return;
    const tree = await getTree(treeId);
    if (!tree || !canReadTree(session, tree)) {
      errorResponse(response, 404, "not_found", "The family tree was not found.");
      return;
    }
    if (request.method === "GET") {
      sendJson(response, 200, { ...rowTree(tree), document: normalizeDocument(tree.document, tree, new Date(tree.updated_at).toISOString()) });
      return;
    }
    if (request.method === "DELETE") {
      if (!canWriteTree(session, tree) || tree.kind === "canonical") {
        errorResponse(response, 403, "forbidden", "This family tree cannot be deleted.");
        return;
      }
      if (!requireCsrf(request, response, session)) return;
      await pool.query("DELETE FROM family_trees WHERE id = $1 AND kind = 'personal' AND owner_id = $2", [tree.id, session.user_id]);
      sendNoContent(response);
      return;
    }
    if (request.method === "PUT") {
      if (!canWriteTree(session, tree)) {
        errorResponse(response, 403, "forbidden", "You cannot edit this family tree.");
        return;
      }
      if (!requireCsrf(request, response, session)) return;
      let body;
      try {
        body = await readBody(request);
      } catch (error) {
        errorResponse(response, error.status ?? 400, "invalid_request", "The family tree update is invalid.");
        return;
      }
      if (!isObject(body) || !Number.isSafeInteger(body.baseRevision) || body.baseRevision !== Number(tree.revision)) {
        errorResponse(response, 409, "revision_conflict", "The family tree changed elsewhere. Reload before editing.");
        return;
      }
      const validationError = validateTreeDocument(body.document, tree.id);
      if (validationError) {
        errorResponse(response, validationError === "document_too_large" ? 413 : 400, validationError, "The family tree data is invalid.");
        return;
      }
      const timestamp = now();
      const document = normalizeDocument(body.document, tree, timestamp);
      const updated = await pool.query(
        `UPDATE family_trees
            SET title = $1, document = $2::jsonb, revision = revision + 1, updated_at = $3
          WHERE id = $4 AND revision = $5
        RETURNING *`,
        [tree.kind === "canonical" ? CANONICAL_TREE_TITLE : document.trees[0].title, JSON.stringify(document), timestamp, tree.id, tree.revision]
      );
      if (!updated.rows[0]) {
        errorResponse(response, 409, "revision_conflict", "The family tree changed elsewhere. Reload before editing.");
        return;
      }
      sendJson(response, 200, { ...rowTree(updated.rows[0]), document: normalizeDocument(updated.rows[0].document, updated.rows[0], timestamp) });
      return;
    }
  }
  if (segments[2] === "trees" && segments.length === 3 && request.method === "POST") {
    const session = await requireSession(request, response);
    if (!session) return;
    if (!isSameOrigin(request) || !requireCsrf(request, response, session)) return;
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      errorResponse(response, error.status ?? 400, "invalid_request", "The family tree request is invalid.");
      return;
    }
    const treeId = body?.treeId === undefined ? randomUUID() : body.treeId;
    if (!validateTreeId(treeId) || treeId === CANONICAL_TREE_ID) {
      errorResponse(response, 400, "invalid_request", "The tree identifier is invalid.");
      return;
    }
    if (!isObject(body.document)) {
      errorResponse(response, 400, "invalid_data", "The family tree data is invalid.");
      return;
    }
    const title = typeof body.document.trees?.[0]?.title === "string" ? body.document.trees[0].title.trim() : "Silsilah Keluarga Saya";
    if (!title || title.length > 160) {
      errorResponse(response, 400, "invalid_data", "The family tree title is invalid.");
      return;
    }
    const validationError = validateTreeDocument(body.document, treeId);
    if (validationError) {
      errorResponse(response, validationError === "document_too_large" ? 413 : 400, validationError, "The family tree data is invalid.");
      return;
    }
    const timestamp = now();
    const document = normalizeDocument(body.document, { id: treeId, kind: "personal", owner_id: session.user_id, title, created_at: timestamp }, timestamp);
    try {
      const inserted = await pool.query(
        `INSERT INTO family_trees (id, kind, owner_id, title, document, revision, created_at, updated_at)
         VALUES ($1, 'personal', $2, $3, $4::jsonb, 0, $5, $5)
         RETURNING *`,
        [treeId, session.user_id, title, JSON.stringify(document), timestamp]
      );
      sendJson(response, 201, { ...rowTree(inserted.rows[0]), document: normalizeDocument(inserted.rows[0].document, inserted.rows[0], timestamp) });
    } catch (error) {
      if (error?.code === "23505") errorResponse(response, 409, "already_exists", "The family tree already exists.");
      else throw error;
    }
    return;
  }
  if (segments[2] === "admin" && segments[3] === "users") {
    const session = await adminRequired(request, response);
    if (!session) return;
    if (request.method === "GET" && segments.length === 4) {
      const users = await pool.query("SELECT * FROM app_users ORDER BY role DESC, username_normalized ASC");
      sendJson(response, 200, { users: users.rows.map(publicUser) });
      return;
    }
    if (segments.length === 4 && request.method === "POST") {
      if (!requireCsrf(request, response, session)) return;
      let body;
      try {
        body = await readBody(request);
      } catch (error) {
        errorResponse(response, error.status ?? 400, "invalid_request", "The user request is invalid.");
        return;
      }
      if (!validateUsername(body?.username) || !validatePassword(body?.password)) {
        errorResponse(response, 400, "invalid_request", "Username must be 3-32 characters and password must be 12-128 characters.");
        return;
      }
      const timestamp = now();
      const hash = await argon2.hash(body.password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
      try {
        const result = await pool.query(
          `INSERT INTO app_users (id, username, username_normalized, password_hash, role, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'user', 'active', $5, $5) RETURNING *`,
          [randomUUID(), body.username.trim(), normalizeUsername(body.username), hash, timestamp]
        );
        sendJson(response, 201, { user: publicUser(result.rows[0]) });
      } catch (error) {
        if (error?.code === "23505") errorResponse(response, 409, "already_exists", "That username is already in use.");
        else throw error;
      }
      return;
    }
    const userId = segments[4];
    if (!userId || !idPattern.test(userId)) {
      errorResponse(response, 400, "invalid_request", "The user identifier is invalid.");
      return;
    }
    const targetResult = await pool.query("SELECT * FROM app_users WHERE id = $1", [userId]);
    const target = targetResult.rows[0];
    if (!target || target.role !== "user") {
      errorResponse(response, 404, "not_found", "The user was not found.");
      return;
    }
    if (!requireCsrf(request, response, session)) return;
    if (request.method === "DELETE") {
      await pool.query("UPDATE app_users SET status = 'disabled', updated_at = NOW() WHERE id = $1 AND role = 'user'", [userId]);
      await pool.query("DELETE FROM app_sessions WHERE user_id = $1", [userId]);
      sendNoContent(response);
      return;
    }
    if (request.method === "PATCH") {
      let body;
      try {
        body = await readBody(request);
      } catch (error) {
        errorResponse(response, error.status ?? 400, "invalid_request", "The user update is invalid.");
        return;
      }
      const updates = [];
      const values = [];
      if (body?.username !== undefined) {
        if (!validateUsername(body.username)) {
          errorResponse(response, 400, "invalid_request", "The username is invalid.");
          return;
        }
        values.push(body.username.trim(), normalizeUsername(body.username));
        updates.push(`username = $${values.length - 1}`, `username_normalized = $${values.length}`);
      }
      if (body?.password !== undefined) {
        if (!validatePassword(body.password)) {
          errorResponse(response, 400, "invalid_request", "The password must be 12-128 characters.");
          return;
        }
        values.push(await argon2.hash(body.password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }));
        updates.push(`password_hash = $${values.length}`);
        await pool.query("DELETE FROM app_sessions WHERE user_id = $1", [userId]);
      }
      if (body?.status !== undefined) {
        if (body.status !== "active" && body.status !== "disabled") {
          errorResponse(response, 400, "invalid_request", "The user status is invalid.");
          return;
        }
        values.push(body.status);
        updates.push(`status = $${values.length}`);
        if (body.status === "disabled") await pool.query("DELETE FROM app_sessions WHERE user_id = $1", [userId]);
      }
      if (!updates.length) {
        errorResponse(response, 400, "invalid_request", "No user changes were provided.");
        return;
      }
      values.push(userId);
      try {
        const updated = await pool.query(`UPDATE app_users SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`, values);
        sendJson(response, 200, { user: publicUser(updated.rows[0]) });
      } catch (error) {
        if (error?.code === "23505") errorResponse(response, 409, "already_exists", "That username is already in use.");
        else throw error;
      }
      return;
    }
  }
  if (segments[2] === "share-uploads" && segments.length === 5 && segments[4] === "blob" && request.method === "PUT") {
    const shareId = segments[3];
    if (!shareIdPattern.test(shareId)) {
      errorResponse(response, 400, "invalid_request", "The share identifier is invalid.");
      return;
    }
    await handleShareUpload(request, response, shareId);
    return;
  }
  if (pathname === "/api/v1/share-uploads" && request.method === "POST") {
    const session = await requireSession(request, response);
    if (!session) return;
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      errorResponse(response, error.status ?? 400, "invalid_request", "The share request is invalid.");
      return;
    }
    await handleShareAllocation(request, response, session, body);
    return;
  }
  if (pathname === "/api/v1/share-uploads/complete" && request.method === "POST") {
    const session = await requireSession(request, response);
    if (!session) return;
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      errorResponse(response, error.status ?? 400, "invalid_request", "The share request is invalid.");
      return;
    }
    await handleShareComplete(request, response, session, body);
    return;
  }
  if (pathname === "/api/v1/share-revocations" && request.method === "POST") {
    const session = await requireSession(request, response);
    if (!session) return;
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      errorResponse(response, error.status ?? 400, "invalid_request", "The share request is invalid.");
      return;
    }
    await handleShareRevocation(request, response, session, body);
    return;
  }
  if (pathname === "/api/v1/share-downloads" && request.method === "POST") {
    let body;
    try {
      body = await readBody(request, 16 * 1024);
    } catch (error) {
      errorResponse(response, error.status ?? 400, "invalid_request", "The share request is invalid.");
      return;
    }
    await handleShareDownloadGrant(request, response, body);
    return;
  }
  if (segments[2] === "share-downloads" && segments.length === 5 && segments[4] === "blob" && request.method === "GET") {
    const shareId = segments[3];
    if (!shareIdPattern.test(shareId)) {
      errorResponse(response, 400, "invalid_request", "The share identifier is invalid.");
      return;
    }
    await handleShareDownload(request, response, shareId);
    return;
  }
  errorResponse(response, 404, "not_found", "The requested resource was not found.");
};

const contentType = (filePath) => {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2"
  }[extension] ?? "application/octet-stream";
};

const escapeHtmlAttribute = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

const requestPublicOrigin = (request) => {
  if (PUBLIC_APP_ORIGIN) return PUBLIC_APP_ORIGIN;
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",", 1)[0]
    .trim()
    .toLowerCase();
  const protocol = forwardedProtocol === "https" || (!forwardedProtocol && COOKIE_SECURE) ? "https" : "http";
  const host = requestHost(request) || "localhost";
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return `${protocol}://localhost`;
  }
};

const decorateSocialMetadata = (html, request, pathname) => {
  const origin = requestPublicOrigin(request);
  const currentUrl = `${origin}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  const imageUrl = `${origin}/soenarto-tree-preview.png`;
  return html
    .replace(/(<meta property="og:url" content=")[^"]*(" data-dynamic-social-url \/>)/u, (_match, prefix, suffix) => `${prefix}${escapeHtmlAttribute(currentUrl)}${suffix}`)
    .replace(/(<meta (?:property="og:image"|name="twitter:image") content=")[^"]*(" data-dynamic-social-image \/>)/gu, (_match, prefix, suffix) => `${prefix}${escapeHtmlAttribute(imageUrl)}${suffix}`);
};

const serveStatic = async (request, response, pathname) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    errorResponse(response, 405, "method_not_allowed", "Method not allowed.");
    return;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//u, "");
  const candidate = path.resolve(STATIC_ROOT, relative);
  if (candidate !== STATIC_ROOT && !candidate.startsWith(`${STATIC_ROOT}${path.sep}`)) {
    errorResponse(response, 400, "invalid_request", "The requested path is invalid.");
    return;
  }
  let filePath = candidate;
  try {
    const info = await fs.stat(filePath);
    if (!info.isFile()) throw new Error("not_file");
  } catch {
    if (path.extname(pathname)) {
      errorResponse(response, 404, "not_found", "The requested resource was not found.");
      return;
    }
    filePath = path.join(STATIC_ROOT, "index.html");
  }
  try {
    let content = await fs.readFile(filePath);
    if (path.basename(filePath) === "index.html") {
      content = Buffer.from(decorateSocialMetadata(content.toString("utf8"), request, pathname), "utf8");
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType(filePath));
    const isShareRoute = pathname.startsWith("/s/");
    response.setHeader("Cache-Control", isShareRoute
      ? "private, no-store"
      : path.basename(filePath) === "index.html" || path.basename(filePath) === "sw.js" || path.basename(filePath) === "manifest.webmanifest"
      ? "no-cache"
      : "public, max-age=31536000, immutable");
    if (isShareRoute) response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    if (request.method === "HEAD") response.end();
    else response.end(content);
  } catch {
    errorResponse(response, 404, "not_found", "The requested resource was not found.");
  }
};

const server = createServer(async (request, response) => {
  securityHeaders(response);
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);
    const segments = pathname.split("/").filter(Boolean);
    if (pathname === "/health" && request.method === "GET") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (pathname === "/ready" && request.method === "GET") {
      try {
        await pool.query("SELECT 1");
        sendJson(response, 200, { status: "ready" });
      } catch {
        errorResponse(response, 503, "service_unavailable", "The service is not ready.");
      }
      return;
    }
    if (pathname.startsWith("/api/v1/")) {
      await handleApi(request, response, pathname, segments);
      return;
    }
    await serveStatic(request, response, pathname);
  } catch (error) {
    if (!response.headersSent) errorResponse(response, error?.status ?? 500, "server_error", error?.status ? "The request could not be processed." : "The server could not process the request.");
    else response.destroy();
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 64;

await initialize();
void cleanupExpiredShares();
const shareCleanupTimer = setInterval(cleanupExpiredShares, 60 * 60 * 1000);
shareCleanupTimer.unref?.();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Soenarto Tree server listening on ${PORT}`);
});

const shutdown = async () => {
  clearInterval(shareCleanupTimer);
  server.close();
  await pool.end();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
