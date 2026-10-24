import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  AuthRequest,
  platformAuthMiddleware,
  requireRoles,
  tenantAuthMiddleware,
} from "./authMiddleware";

const secret = process.env.JWT_SECRET || "secret";

const createRequest = (token?: string): AuthRequest => ({
  headers: token ? { authorization: `Bearer ${token}` } : {},
} as AuthRequest);

const createResponse = () => {
  const response: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return response;
};

test("platform token is rejected by tenant auth middleware", async () => {
  const token = jwt.sign({ userId: "platform-user", roles: ["SUPER_ADMIN"], scope: "PLATFORM" }, secret);
  const req = createRequest(token);
  const res = createResponse();
  let calledNext = false;

  await tenantAuthMiddleware(req, res, () => {
    calledNext = true;
  });

  assert.equal(calledNext, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "Tenant token required" });
});

test("tenant token is rejected by platform auth middleware", () => {
  const token = jwt.sign({ userId: "tenant-user", tenantId: "tenant-1", roles: ["SHOP_ADMIN"], scope: "TENANT" }, secret);
  const req = createRequest(token);
  const res = createResponse();
  let calledNext = false;

  platformAuthMiddleware(req, res, () => {
    calledNext = true;
  });

  assert.equal(calledNext, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "Platform token required" });
});

test("SUPER_ADMIN no longer bypasses tenant role checks", () => {
  const req = {
    user: {
      userId: "legacy-super-admin",
      tenantId: "tenant-1",
      roles: ["SUPER_ADMIN"],
      scope: "TENANT",
    },
  } as AuthRequest;
  const res = createResponse();
  let calledNext = false;

  requireRoles(["SHOP_ADMIN"])(req, res, () => {
    calledNext = true;
  });

  assert.equal(calledNext, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "Access Denied" });
});
