import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const membership = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
  };
  const user = {
    findUnique: vi.fn(),
    create: vi.fn(),
  };
  const transaction = { membership, user };

  return {
    prisma: {
      ...transaction,
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => Promise<unknown>) =>
          callback(transaction)
      ),
    },
  };
});

vi.mock("../src/lib/prisma.js", () => ({ prisma: mocks.prisma }));

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import request from "supertest";
import app from "../src/app.js";

const organizationId = "org-one";
const adminId = "admin-one";
const memberId = "member-one";
const existingUserId = "existing-user";
const newUserId = "new-user";
const jwtSecret = "organization-member-tests-secret";

function authHeader(userId = adminId) {
  const token = jwt.sign({ sub: userId }, jwtSecret);
  return { Authorization: `Bearer ${token}` };
}

function makeMembership(
  userId: string,
  role: "ADMIN" | "MEMBER" = "MEMBER",
  status: "ACTIVE" | "INVITED" | "SUSPENDED" = "ACTIVE"
) {
  const users: Record<string, { id: string; name: string | null; email: string }> = {
    [adminId]: { id: adminId, name: "Admin", email: "admin@example.com" },
    [memberId]: { id: memberId, name: "Member", email: "member@example.com" },
    [existingUserId]: {
      id: existingUserId,
      name: "Existing User",
      email: "existing@example.com",
    },
    [newUserId]: { id: newUserId, name: "New User", email: "new@example.com" },
  };

  return {
    userId,
    role,
    status,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    user: users[userId] ?? { id: userId, name: null, email: `${userId}@example.com` },
  };
}

describe("organization member management", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = jwtSecret;
    vi.clearAllMocks();

    mocks.prisma.membership.findFirst.mockImplementation(
      async ({ where }: { where: { userId: string; organizationId: string } }) =>
        where.userId === adminId && where.organizationId === organizationId
          ? { organizationId, role: "ADMIN" }
          : null
    );
    mocks.prisma.membership.findUnique.mockResolvedValue(null);
    mocks.prisma.membership.create.mockImplementation(
      async ({ data }: { data: { userId: string; role: "ADMIN" | "MEMBER"; status: "ACTIVE" } }) =>
        makeMembership(data.userId, data.role, data.status)
    );
    mocks.prisma.membership.findMany.mockResolvedValue([]);
    mocks.prisma.membership.count.mockResolvedValue(0);
    mocks.prisma.membership.update.mockImplementation(
      async ({ where, data }: { where: { organizationId_userId: { userId: string } }; data: { status: "ACTIVE" | "SUSPENDED" } }) =>
        makeMembership(where.organizationId_userId.userId, "MEMBER", data.status)
    );
    mocks.prisma.user.findUnique.mockResolvedValue({ id: existingUserId });
    mocks.prisma.user.create.mockResolvedValue({ id: newUserId });
  });

  it("returns 401 for unauthenticated member management requests", async () => {
    const response = await request(app).get(`/api/organization/${organizationId}/members`);

    expect(response.status).toBe(401);
  });

  it("returns 403 when the requester is not an active organization member", async () => {
    mocks.prisma.membership.findFirst.mockResolvedValue(null);

    const response = await request(app)
      .get(`/api/organization/${organizationId}/members`)
      .set(authHeader());

    expect(response.status).toBe(403);
  });

  it("does not allow a MEMBER to add users", async () => {
    mocks.prisma.membership.findFirst.mockResolvedValue({
      organizationId,
      role: "MEMBER",
    });

    const response = await request(app)
      .post(`/api/organization/${organizationId}/members`)
      .set(authHeader())
      .send({ email: "existing@example.com", role: "MEMBER" });

    expect(response.status).toBe(403);
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("allows an ADMIN to add an existing user with a scoped ACTIVE membership", async () => {
    const response = await request(app)
      .post(`/api/organization/${organizationId}/members`)
      .set(authHeader())
      .send({ email: " EXISTING@example.com ", role: "MEMBER" });

    expect(response.status).toBe(201);
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "existing@example.com" } })
    );
    expect(mocks.prisma.membership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          organizationId,
          userId: existingUserId,
          role: "MEMBER",
          status: "ACTIVE",
        },
      })
    );
    expect(response.body.data.member).not.toHaveProperty("passwordHash");
  });

  it("returns 404 for an unknown email", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null);

    const response = await request(app)
      .post(`/api/organization/${organizationId}/members`)
      .set(authHeader())
      .send({ email: "unknown@example.com", role: "MEMBER" });

    expect(response.status).toBe(404);
  });

  it("returns 409 for an existing membership", async () => {
    mocks.prisma.membership.findUnique.mockResolvedValue({ id: "membership-one" });

    const response = await request(app)
      .post(`/api/organization/${organizationId}/members`)
      .set(authHeader())
      .send({ email: "existing@example.com", role: "MEMBER" });

    expect(response.status).toBe(409);
    expect(mocks.prisma.membership.create).not.toHaveBeenCalled();
  });

  it("adds an existing user to this organization without changing other memberships", async () => {
    const response = await request(app)
      .post(`/api/organization/${organizationId}/members`)
      .set(authHeader())
      .send({ email: "existing@example.com", role: "ADMIN" });

    expect(response.status).toBe(201);
    expect(mocks.prisma.membership.create).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.membership.create.mock.calls[0]?.[0].data).toEqual({
      organizationId,
      userId: existingUserId,
      role: "ADMIN",
      status: "ACTIVE",
    });
  });

  it("creates the user and membership atomically with a bcrypt hash", async () => {
    mocks.prisma.membership.create.mockResolvedValue(makeMembership(newUserId));

    const response = await request(app)
      .post(`/api/organization/${organizationId}/members/create`)
      .set(authHeader())
      .send({
        name: "New User",
        email: " NEW@Example.com ",
        password: "StrongPassword2026!",
        role: "MEMBER",
      });

    expect(response.status).toBe(201);
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    const createUserCall = mocks.prisma.user.create.mock.calls[0]?.[0];
    expect(createUserCall.data.email).toBe("new@example.com");
    expect(createUserCall.data.passwordHash).not.toBe("StrongPassword2026!");
    expect(await bcrypt.compare("StrongPassword2026!", createUserCall.data.passwordHash)).toBe(true);
    expect(mocks.prisma.membership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          organizationId,
          userId: newUserId,
          role: "MEMBER",
          status: "ACTIVE",
        },
      })
    );
    expect(response.body).not.toHaveProperty("passwordHash");
  });

  it("returns 409 for a duplicate global email and does not create membership", async () => {
    mocks.prisma.user.create.mockRejectedValue({ code: "P2002" });

    const response = await request(app)
      .post(`/api/organization/${organizationId}/members/create`)
      .set(authHeader())
      .send({
        name: "Existing User",
        email: "existing@example.com",
        password: "StrongPassword2026!",
        role: "MEMBER",
      });

    expect(response.status).toBe(409);
    expect(response.body.message).toContain("existing-user member endpoint");
    expect(mocks.prisma.membership.create).not.toHaveBeenCalled();
  });

  it("lists only members scoped to the requested organization", async () => {
    mocks.prisma.membership.findMany.mockResolvedValue([makeMembership(memberId)]);
    mocks.prisma.membership.count.mockResolvedValue(1);

    const response = await request(app)
      .get(`/api/organization/${organizationId}/members?page=1&limit=10`)
      .set(authHeader());

    expect(response.status).toBe(200);
    expect(mocks.prisma.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId },
        skip: 0,
        take: 10,
      })
    );
    expect(mocks.prisma.membership.count).toHaveBeenCalledWith({
      where: { organizationId },
    });
    expect(response.body.data.members[0]).toMatchObject({
      userId: memberId,
      email: "member@example.com",
      status: "ACTIVE",
    });
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
  });

  it("suspended users immediately lose organization access", async () => {
    mocks.prisma.membership.findFirst.mockImplementation(
      async ({ where }: { where: { userId: string; organizationId: string } }) => {
        if (where.userId === adminId && where.organizationId === organizationId) {
          return { organizationId, role: "ADMIN" };
        }
        return where.userId === memberId ? makeMembership(memberId) : null;
      }
    );
    mocks.prisma.membership.count.mockResolvedValue(2);

    const patchResponse = await request(app)
      .patch(`/api/organization/${organizationId}/members/${memberId}/status`)
      .set(authHeader())
      .send({ status: "SUSPENDED" });

    expect(patchResponse.status).toBe(200);
    expect(mocks.prisma.membership.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_userId: { organizationId, userId: memberId } },
        data: { status: "SUSPENDED" },
      })
    );

    mocks.prisma.membership.findFirst.mockResolvedValue(null);
    const accessResponse = await request(app)
      .get(`/api/organization/${organizationId}`)
      .set(authHeader(memberId));

    expect(accessResponse.status).toBe(403);
  });

  it("does not allow suspension of the last active ADMIN", async () => {
    mocks.prisma.membership.findFirst.mockImplementation(
      async ({ where }: { where: { userId: string; organizationId: string; status?: string } }) => {
        if (
          where.userId === adminId &&
          where.organizationId === organizationId &&
          where.status === "ACTIVE"
        ) {
          return { organizationId, role: "ADMIN" };
        }
        return makeMembership(adminId, "ADMIN");
      }
    );
    mocks.prisma.membership.count.mockResolvedValue(1);

    const response = await request(app)
      .patch(`/api/organization/${organizationId}/members/${adminId}/status`)
      .set(authHeader())
      .send({ status: "SUSPENDED" });

    expect(response.status).toBe(409);
    expect(mocks.prisma.membership.update).not.toHaveBeenCalled();
  });

  it("denies membership changes for users outside the requested organization", async () => {
    mocks.prisma.membership.findFirst.mockImplementation(
      async ({ where }: { where: { userId: string; organizationId: string } }) =>
        where.userId === adminId
          ? { organizationId, role: "ADMIN" }
          : null
    );

    const response = await request(app)
      .patch(`/api/organization/${organizationId}/members/${memberId}/status`)
      .set(authHeader())
      .send({ status: "SUSPENDED" });

    expect(response.status).toBe(404);
    expect(mocks.prisma.membership.findFirst).toHaveBeenLastCalledWith({
      where: { organizationId, userId: memberId },
      select: { userId: true, role: true, status: true },
    });
    expect(mocks.prisma.membership.update).not.toHaveBeenCalled();
  });

  it("rejects invalid pagination and status input", async () => {
    const paginationResponse = await request(app)
      .get(`/api/organization/${organizationId}/members?limit=101`)
      .set(authHeader());
    const statusResponse = await request(app)
      .patch(`/api/organization/${organizationId}/members/${memberId}/status`)
      .set(authHeader())
      .send({ status: "INVITED" });

    expect(paginationResponse.status).toBe(400);
    expect(statusResponse.status).toBe(400);
  });
});
