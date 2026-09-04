const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/u, "");
const adminUsername = process.env.SMOKE_ADMIN_USERNAME ?? "admin";
const adminPassword = process.env.SMOKE_ADMIN_PASSWORD ?? "LocalAdminPassword!ChangeMe123";
const userPassword = process.env.SMOKE_USER_PASSWORD ?? "SmokeUser!ChangeMe123";
const createJar = () => new Map();
const anonymousCookies = createJar();
const adminCookies = createJar();
const userACookies = createJar();
const userBCookies = createJar();

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const saveCookies = (jar, response) => {
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
};

const request = async (jar, path, method, body, csrf) => {
  const headers = { origin: baseUrl };
  if (jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  if (csrf) headers["x-csrf-token"] = csrf;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error"
  });
  saveCookies(jar, response);
  return { status: response.status, body: await response.text() };
};

const json = (response) => response.body ? JSON.parse(response.body) : undefined;
const expectStatus = (response, status, label) => assert(response.status === status, `${label}: expected ${status}, got ${response.status} (${response.body})`);

const timestamp = new Date().toISOString();
const suffix = `${Date.now()}${Math.floor(Math.random() * 1_000)}`;
const userAName = `qa${suffix}`.slice(0, 32);
const userBName = `qb${suffix}`.slice(0, 32);
const treeAId = `smoke-${suffix}`.slice(0, 128);
const canonicalId = "soenarto-canonical";
let adminCsrf;
let userACsrf;
let userBCsrf;
let userAId;
let userBId;

try {
  const publicTree = await request(anonymousCookies, "/api/v1/public/canonical-tree", "GET");
  expectStatus(publicTree, 200, "anonymous canonical read");
  const publicValue = json(publicTree);
  assert(publicValue.kind === "canonical", "anonymous canonical kind mismatch");
  assert(publicValue.title === "Keluarga Haji Soenarto", "anonymous canonical title mismatch");
  expectStatus(await request(anonymousCookies, "/api/v1/workspace", "GET"), 401, "anonymous workspace read");
  expectStatus(await request(anonymousCookies, `/api/v1/trees/${canonicalId}`, "GET"), 401, "anonymous direct tree read");

  const adminLogin = await request(adminCookies, "/api/v1/auth/login/admin", "POST", { username: adminUsername, password: adminPassword });
  expectStatus(adminLogin, 200, "admin login");
  adminCsrf = json(adminLogin).csrfToken;
  assert(typeof adminCsrf === "string", "admin login did not return CSRF");
  expectStatus(await request(adminCookies, `/api/v1/trees/${canonicalId}`, "DELETE", undefined, adminCsrf), 403, "canonical delete protection");

  const createA = await request(adminCookies, "/api/v1/admin/users", "POST", { username: userAName, password: userPassword, role: "admin" }, adminCsrf);
  const createB = await request(adminCookies, "/api/v1/admin/users", "POST", { username: userBName, password: userPassword }, adminCsrf);
  expectStatus(createA, 201, "user A creation");
  expectStatus(createB, 201, "user B creation");
  userAId = json(createA).user.id;
  userBId = json(createB).user.id;
  const users = json(await request(adminCookies, "/api/v1/admin/users", "GET", undefined, adminCsrf)).users;
  assert(users.filter((user) => user.role === "admin").length === 1, "more than one admin is exposed");

  const loginA = await request(userACookies, "/api/v1/auth/login/user", "POST", { username: userAName, password: userPassword });
  expectStatus(loginA, 200, "user A login");
  userACsrf = json(loginA).csrfToken;
  const loginB = await request(userBCookies, "/api/v1/auth/login/user", "POST", { username: userBName, password: userPassword });
  expectStatus(loginB, 200, "user B login");
  userBCsrf = json(loginB).csrfToken;

  const workspace = await request(userACookies, "/api/v1/workspace", "GET");
  expectStatus(workspace, 200, "user workspace read");
  const workspaceValue = json(workspace);
  assert(workspaceValue.canonical.kind === "canonical" && workspaceValue.trees.length === 0, "user workspace is not isolated");

  const document = {
    version: 1,
    trees: [{ id: treeAId, title: "Tree A", createdAt: timestamp, updatedAt: timestamp, kind: "personal" }],
    people: [],
    relationships: [],
    selectedTreeId: treeAId,
    language: "id",
    relationshipLanguage: "id",
    relationshipTerminology: "id",
    viewports: {}
  };
  expectStatus(await request(userACookies, "/api/v1/trees", "POST", { treeId: treeAId, document }), 403, "missing CSRF protection");
  expectStatus(await request(userACookies, "/api/v1/trees", "POST", { treeId: treeAId, document }, userACsrf), 201, "user A tree creation");
  expectStatus(await request(userACookies, `/api/v1/trees/${treeAId}`, "GET", undefined, userACsrf), 200, "owner tree read");

  const unsafePhotoDocument = {
    ...document,
    people: [{
      id: "photo-test-person",
      treeId: treeAId,
      displayName: "Photo Test",
      gender: "unspecified",
      createdAt: timestamp,
      photoDataUrl: "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSkgLz4="
    }]
  };
  expectStatus(await request(userACookies, `/api/v1/trees/${treeAId}`, "PUT", { baseRevision: 0, document: unsafePhotoDocument }, userACsrf), 400, "unsafe photo rejection");

  const shareAllocationResponse = await request(userACookies, "/api/v1/share-uploads", "POST", {
    envelopeVersion: "HTGSHR02",
    ciphertextBytes: 52,
    expiryDays: 7
  }, userACsrf);
  expectStatus(shareAllocationResponse, 201, "share allocation");
  const shareAllocation = json(shareAllocationResponse);
  assert(typeof shareAllocation.uploadUrl === "string" && typeof shareAllocation.deletionToken === "string", "share allocation is incomplete");
  const envelope = Buffer.alloc(52);
  envelope.write("HTGSHR02", 0, "ascii");
  const uploadResponse = await fetch(shareAllocation.uploadUrl, {
    method: "PUT",
    headers: shareAllocation.requiredHeaders,
    body: envelope,
    redirect: "error"
  });
  expectStatus({ status: uploadResponse.status, body: await uploadResponse.text() }, 204, "share ciphertext upload");
  const generation = uploadResponse.headers.get("x-soenarto-generation");
  assert(generation && /^[1-9][0-9]{0,30}$/.test(generation), "share upload generation is invalid");
  expectStatus(await request(userACookies, "/api/v1/share-uploads/complete", "POST", {
    shareId: shareAllocation.shareId,
    deletionToken: shareAllocation.deletionToken,
    objectGeneration: generation
  }, userACsrf), 200, "share activation");
  const grantResponse = await request(anonymousCookies, "/api/v1/share-downloads", "POST", { shareId: shareAllocation.shareId });
  expectStatus(grantResponse, 200, "share download grant");
  const grant = json(grantResponse);
  const downloadResponse = await fetch(grant.downloadUrl, { redirect: "error" });
  const downloadedEnvelope = Buffer.from(await downloadResponse.arrayBuffer());
  expectStatus({ status: downloadResponse.status, body: downloadedEnvelope.toString("hex") }, 200, "share ciphertext download");
  assert(downloadedEnvelope.equals(envelope), "share ciphertext was changed in storage");
  expectStatus(await request(userBCookies, "/api/v1/share-revocations", "POST", {
    shareId: shareAllocation.shareId,
    deletionToken: shareAllocation.deletionToken
  }, userBCsrf), 403, "cross-user share revocation protection");
  expectStatus(await request(userACookies, "/api/v1/share-revocations", "POST", {
    shareId: shareAllocation.shareId,
    deletionToken: shareAllocation.deletionToken
  }, userACsrf), 200, "share revocation");
  expectStatus(await request(anonymousCookies, "/api/v1/share-downloads", "POST", { shareId: shareAllocation.shareId }), 410, "revoked share protection");

  expectStatus(await request(userBCookies, `/api/v1/trees/${treeAId}`, "GET", undefined, userBCsrf), 404, "cross-user tree read");
  expectStatus(await request(userBCookies, `/api/v1/trees/${treeAId}`, "PUT", { baseRevision: 0, document }, userBCsrf), 404, "cross-user tree write");
  expectStatus(await request(userBCookies, `/api/v1/trees/${treeAId}`, "DELETE", undefined, userBCsrf), 404, "cross-user tree delete");
  expectStatus(await request(userBCookies, `/api/v1/trees/${canonicalId}`, "GET", undefined, userBCsrf), 200, "canonical read-only access");
  expectStatus(await request(userACookies, `/api/v1/trees/${canonicalId}`, "PUT", { baseRevision: 0, document }, userACsrf), 403, "canonical user write protection");
  expectStatus(await request(adminCookies, `/api/v1/trees/${treeAId}`, "GET", undefined, adminCsrf), 404, "admin personal-tree isolation");
} finally {
  if (adminCsrf && userAId) await request(adminCookies, `/api/v1/admin/users/${userAId}`, "DELETE", undefined, adminCsrf);
  if (adminCsrf && userBId) await request(adminCookies, `/api/v1/admin/users/${userBId}`, "DELETE", undefined, adminCsrf);
}

console.log("RBAC/BOLA smoke test passed: anonymous canonical, fixed admin, user-owned tree, cross-user 404, canonical protection, and CSRF protection.");
