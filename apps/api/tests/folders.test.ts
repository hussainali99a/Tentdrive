import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const folder = {
    findFirst: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  };
  const file = { count: vi.fn() };
  const membership = { findFirst: vi.fn() };
  const transaction = { folder, file };

  return {
    prisma: {
      folder,
      file,
      membership,
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => Promise<unknown>) =>
          callback(transaction)
      ),
    },
  };
});

vi.mock("../src/lib/prisma.js", () => ({ prisma: mocks.prisma }));

import jwt from "jsonwebtoken";
import request from "supertest";
import app from "../src/app.js";

const organizationId = "org-one";
const otherOrganizationId = "org-two";
const userId = "user-one";
const otherUserId = "user-two";
const parentId = "parent-folder";
const folderId = "folder-one";
const jwtSecret = "folder-route-tests-secret";

function authHeader(tokenUserId = userId) {
  return {
    Authorization: `Bearer ${jwt.sign({ sub: tokenUserId }, jwtSecret)}`,
  };
}

function makeFolder(
  id = folderId,
  owner = userId,
  parent: string | null = null,
  org = organizationId,
  name = "Folder"
) {
  return {
    id,
    organizationId: org,
    ownerId: owner,
    name,
    parentId: parent,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    updatedAt: new Date("2026-01-02T03:04:05.000Z"),
  };
}

describe("organization folder routes", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = jwtSecret;
    vi.clearAllMocks();

    mocks.prisma.membership.findFirst.mockImplementation(
      async ({ where }: { where: { userId: string; organizationId: string } }) =>
        where.organizationId === organizationId
          ? { organizationId, role: "MEMBER" }
          : null
    );
    mocks.prisma.folder.findFirst.mockResolvedValue(null);
    mocks.prisma.folder.create.mockImplementation(
      async ({
        data,
      }: {
        data: {
          organizationId: string;
          ownerId: string;
          name: string;
          parentId: string | null;
        };
      }) => makeFolder(folderId, data.ownerId, data.parentId, data.organizationId, data.name)
    );
    mocks.prisma.folder.findMany.mockResolvedValue([]);
    mocks.prisma.folder.count.mockResolvedValue(0);
    mocks.prisma.folder.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.folder.deleteMany.mockResolvedValue({ count: 1 });
    mocks.prisma.file.count.mockResolvedValue(0);
  });

  it("returns 401 for unauthenticated folder creation", async () => {
    const response = await request(app)
      .post(`/api/organization/${organizationId}/folders`)
      .send({ name: "Reports" });

    expect(response.status).toBe(401);
    expect(mocks.prisma.folder.create).not.toHaveBeenCalled();
  });

  it("denies folder listing to a non-member", async () => {
    mocks.prisma.membership.findFirst.mockResolvedValue(null);

    const response = await request(app)
      .get(`/api/organization/${organizationId}/folders`)
      .set(authHeader());

    expect(response.status).toBe(403);
    expect(mocks.prisma.folder.findMany).not.toHaveBeenCalled();
  });

  it("allows an active member to create a root folder using their authenticated identity", async () => {
    const response = await request(app)
      .post(`/api/organization/${organizationId}/folders`)
      .set(authHeader())
      .send({ name: "  Reports  " });

    expect(response.status).toBe(201);
    expect(response.body.data.folder).toMatchObject({
      organizationId,
      ownerId: userId,
      name: "Reports",
      parentId: null,
    });
    expect(mocks.prisma.folder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          organizationId,
          ownerId: userId,
          name: "Reports",
          parentId: null,
        },
      })
    );
  });

  it("allows an active member to create a nested folder under a same-organization parent", async () => {
    mocks.prisma.folder.findFirst.mockResolvedValue({ id: parentId });

    const response = await request(app)
      .post(`/api/organization/${organizationId}/folders`)
      .set(authHeader())
      .send({ name: "Quarterly", parentId });

    expect(response.status).toBe(201);
    expect(mocks.prisma.folder.findFirst).toHaveBeenCalledWith({
      where: { id: parentId, organizationId },
      select: { id: true },
    });
    expect(response.body.data.folder.parentId).toBe(parentId);
  });

  it("rejects invalid folder names and untrusted owner fields", async () => {
    const invalidName = await request(app)
      .post(`/api/organization/${organizationId}/folders`)
      .set(authHeader())
      .send({ name: "   " });
    const ownerOverride = await request(app)
      .post(`/api/organization/${organizationId}/folders`)
      .set(authHeader())
      .send({ name: "Reports", ownerId: otherUserId });
    const selfParent = await request(app)
      .post(`/api/organization/${organizationId}/folders`)
      .set(authHeader())
      .send({ id: folderId, name: "Self", parentId: folderId });

    expect(invalidName.status).toBe(400);
    expect(ownerOverride.status).toBe(400);
    expect(selfParent.status).toBe(400);
    expect(mocks.prisma.folder.create).not.toHaveBeenCalled();
  });

  it("returns 404 for nonexistent and cross-organization parents", async () => {
    const response = await request(app)
      .post(`/api/organization/${organizationId}/folders`)
      .set(authHeader())
      .send({ name: "Nested", parentId: "foreign-parent" });

    expect(response.status).toBe(404);
    expect(mocks.prisma.folder.findFirst).toHaveBeenCalledWith({
      where: { id: "foreign-parent", organizationId },
      select: { id: true },
    });
    expect(mocks.prisma.folder.create).not.toHaveBeenCalled();
  });

  it("lists only the selected organization's root folders", async () => {
    const ownFolder = makeFolder(folderId);
    mocks.prisma.folder.findMany.mockResolvedValue([ownFolder]);
    mocks.prisma.folder.count.mockResolvedValue(1);

    const response = await request(app)
      .get(`/api/organization/${organizationId}/folders?parentId=null`)
      .set(authHeader());

    expect(response.status).toBe(200);
    expect(mocks.prisma.folder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId, parentId: null },
        skip: 0,
        take: 20,
      })
    );
    expect(response.body.data.folders.map((folder: { id: string }) => folder.id)).toEqual([
      folderId,
    ]);
    expect(response.body.data.folders).not.toContainEqual(
      expect.objectContaining({ organizationId: otherOrganizationId })
    );
  });

  it("returns folders only from the organization in the route", async () => {
    mocks.prisma.folder.findMany.mockResolvedValue([makeFolder(folderId)]);

    const response = await request(app)
      .get(`/api/organization/${organizationId}/folders`)
      .set(authHeader());

    expect(response.status).toBe(200);
    expect(mocks.prisma.folder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId, parentId: null },
      })
    );
    expect(response.body.data.folders.every(
      (folder: { organizationId: string }) => folder.organizationId === organizationId
    )).toBe(true);
  });

  it("allows the owner to rename a folder", async () => {
    mocks.prisma.folder.findFirst
      .mockResolvedValueOnce({ ownerId: userId })
      .mockResolvedValueOnce(makeFolder(folderId, userId, null, organizationId, "Renamed"));

    const response = await request(app)
      .patch(`/api/organization/${organizationId}/folders/${folderId}`)
      .set(authHeader())
      .send({ name: "  Renamed  " });

    expect(response.status).toBe(200);
    expect(response.body.data.folder.name).toBe("Renamed");
    expect(mocks.prisma.folder.updateMany).toHaveBeenCalledWith({
      where: { id: folderId, organizationId, ownerId: userId },
      data: { name: "Renamed" },
    });
  });

  it("does not allow another member to rename a folder", async () => {
    mocks.prisma.folder.findFirst.mockResolvedValue({ ownerId: otherUserId });

    const response = await request(app)
      .patch(`/api/organization/${organizationId}/folders/${folderId}`)
      .set(authHeader())
      .send({ name: "Changed" });

    expect(response.status).toBe(403);
    expect(mocks.prisma.folder.updateMany).not.toHaveBeenCalled();
  });

  it("allows the owner to delete an empty folder", async () => {
    mocks.prisma.folder.findFirst.mockResolvedValue({ ownerId: userId });

    const response = await request(app)
      .delete(`/api/organization/${organizationId}/folders/${folderId}`)
      .set(authHeader());

    expect(response.status).toBe(200);
    expect(mocks.prisma.folder.deleteMany).toHaveBeenCalledWith({
      where: { id: folderId, organizationId, ownerId: userId },
    });
  });

  it("rejects deletion when a folder contains child folders", async () => {
    mocks.prisma.folder.findFirst.mockResolvedValue({ ownerId: userId });
    mocks.prisma.folder.count.mockResolvedValue(1);

    const response = await request(app)
      .delete(`/api/organization/${organizationId}/folders/${folderId}`)
      .set(authHeader());

    expect(response.status).toBe(409);
    expect(mocks.prisma.folder.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects deletion when a folder contains files", async () => {
    mocks.prisma.folder.findFirst.mockResolvedValue({ ownerId: userId });
    mocks.prisma.file.count.mockResolvedValue(1);

    const response = await request(app)
      .delete(`/api/organization/${organizationId}/folders/${folderId}`)
      .set(authHeader());

    expect(response.status).toBe(409);
    expect(mocks.prisma.folder.deleteMany).not.toHaveBeenCalled();
  });

  it("does not disclose folder details across organizations", async () => {
    mocks.prisma.folder.findFirst.mockResolvedValue(null);

    const response = await request(app)
      .get(`/api/organization/${organizationId}/folders/${folderId}`)
      .set(authHeader());

    expect(response.status).toBe(404);
    expect(response.body.data).toBeUndefined();
    expect(mocks.prisma.folder.findFirst).toHaveBeenCalledWith({
      where: { id: folderId, organizationId },
      select: expect.any(Object),
    });
  });

  it("does not allow a non-owner to delete a folder", async () => {
    mocks.prisma.folder.findFirst.mockResolvedValue({ ownerId: otherUserId });

    const response = await request(app)
      .delete(`/api/organization/${organizationId}/folders/${folderId}`)
      .set(authHeader());

    expect(response.status).toBe(403);
    expect(mocks.prisma.folder.deleteMany).not.toHaveBeenCalled();
  });
});
