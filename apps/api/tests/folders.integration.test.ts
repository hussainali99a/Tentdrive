import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";

const runIntegrationTests =
  process.env.TENANTDRIVE_RUN_DB_INTEGRATION === "1";
const integrationDescribe = runIntegrationTests ? describe : describe.skip;
const fixtureSuffix = randomUUID().replace(/-/g, "");
const fixtureEmail = `tenantdrive-folder-it-${fixtureSuffix}@example.test`;

let app: (typeof import("../src/app.js"))["default"];
let prisma: (typeof import("../src/lib/prisma.js"))["prisma"];
let userId: string;
let abcOrganizationId: string;
let xyzOrganizationId: string;
let token: string;

const folderIds: string[] = [];
const fileIds: string[] = [];

function authHeader() {
  return { Authorization: `Bearer ${token}` };
}

async function createFolder(
  organizationId: string,
  name: string,
  parentId?: string
) {
  const response = await request(app)
    .post(`/api/organization/${organizationId}/folders`)
    .set(authHeader())
    .send({ name, ...(parentId ? { parentId } : {}) });

  const createdId = response.body?.data?.folder?.id;
  if (typeof createdId === "string") folderIds.push(createdId);
  return response;
}

integrationDescribe("folder routes (database integration)", () => {
  beforeAll(async () => {
    const selectedTestDatabase = process.env.TENANTDRIVE_TEST_DATABASE_URL;

    if (selectedTestDatabase) {
      const databaseName = new URL(selectedTestDatabase).pathname.replace(
        /^\//,
        ""
      );
      if (!/test/i.test(databaseName)) {
        throw new Error(
          "TENANTDRIVE_TEST_DATABASE_URL must point to a database with 'test' in its name"
        );
      }
      process.env.DATABASE_URL = selectedTestDatabase;
    } else {
      const configuredDatabase = process.env.DATABASE_URL;
      if (!configuredDatabase) throw new Error("DATABASE_URL is not configured");

      const databaseUrl = new URL(configuredDatabase);
      const localDatabase =
        ["localhost", "127.0.0.1", "::1"].includes(databaseUrl.hostname) &&
        databaseUrl.pathname.replace(/^\//, "") === "tenantdrive";
      if (
        !localDatabase ||
        process.env.TENANTDRIVE_ALLOW_LOCAL_DEV_DATABASE !== "1"
      ) {
        throw new Error(
          "Without TENANTDRIVE_TEST_DATABASE_URL, explicitly allow only the local tenantdrive database"
        );
      }
    }

    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is not configured");
    }

    const [{ default: loadedApp }, { prisma: loadedPrisma }] = await Promise.all([
      import("../src/app.js"),
      import("../src/lib/prisma.js"),
    ]);
    app = loadedApp;
    prisma = loadedPrisma;

    const [abcOrganization, xyzOrganization] = await Promise.all([
      prisma.organization.findUnique({
        where: { slug: "abc-technologies" },
        select: { id: true },
      }),
      prisma.organization.findUnique({
        where: { slug: "xyz-logistics" },
        select: { id: true },
      }),
    ]);

    if (!abcOrganization || !xyzOrganization) {
      throw new Error("The ABC Technologies and XYZ Logistics fixtures are required");
    }

    abcOrganizationId = abcOrganization.id;
    xyzOrganizationId = xyzOrganization.id;

    const fixtureUser = await prisma.user.create({
      data: {
        name: "TenantDrive Folder Integration User",
        email: fixtureEmail,
        passwordHash: "integration-fixture-password-hash",
      },
      select: { id: true },
    });
    userId = fixtureUser.id;

    await prisma.membership.createMany({
      data: [abcOrganizationId, xyzOrganizationId].map((organizationId) => ({
        organizationId,
        userId,
        role: "MEMBER" as const,
        status: "ACTIVE" as const,
      })),
    });

    token = jwt.sign({ sub: userId }, process.env.JWT_SECRET);
  });

  afterAll(async () => {
    if (!prisma) return;

    try {
      if (fileIds.length) {
        await prisma.file.deleteMany({
          where: { id: { in: fileIds } },
        });
      }

      for (const id of [...folderIds].reverse()) {
        await prisma.folder.deleteMany({
          where: {
            id,
            organizationId: { in: [abcOrganizationId, xyzOrganizationId] },
          },
        });
      }

      if (userId) {
        await prisma.membership.deleteMany({ where: { userId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it("creates and lists organization-scoped folders, rejects cross-tenant parents, and deletes only empty folders", async () => {
    const rootResponse = await createFolder(abcOrganizationId, "Integration Root");
    expect(rootResponse.status).toBe(201);
    const rootId: string = rootResponse.body.data.folder.id;
    expect(rootResponse.body.data.folder).toMatchObject({
      organizationId: abcOrganizationId,
      ownerId: userId,
      parentId: null,
    });

    const xyzRootResponse = await createFolder(
      xyzOrganizationId,
      "Integration XYZ Root"
    );
    expect(xyzRootResponse.status).toBe(201);
    const xyzRootId: string = xyzRootResponse.body.data.folder.id;

    const selfParentId = `folder-self-${fixtureSuffix}`;
    await expect(
      prisma.folder.create({
        data: {
          id: selfParentId,
          organizationId: abcOrganizationId,
          ownerId: userId,
          name: "Invalid Self Parent",
          parentId: selfParentId,
        },
      })
    ).rejects.toThrow();

    const childResponse = await createFolder(
      abcOrganizationId,
      "Integration Child",
      rootId
    );
    expect(childResponse.status).toBe(201);
    const childId: string = childResponse.body.data.folder.id;

    const abcListResponse = await request(app)
      .get(`/api/organization/${abcOrganizationId}/folders`)
      .set(authHeader());
    expect(abcListResponse.status).toBe(200);
    const rootIds = abcListResponse.body.data.folders.map(
      (folder: { id: string }) => folder.id
    );
    expect(rootIds).toContain(rootId);
    expect(rootIds).not.toContain(xyzRootId);

    const foreignParentResponse = await createFolder(
      abcOrganizationId,
      "Invalid Cross Organization Child",
      xyzRootId
    );
    expect(foreignParentResponse.status).toBe(404);

    const crossTenantDetails = await request(app)
      .get(`/api/organization/${abcOrganizationId}/folders/${xyzRootId}`)
      .set(authHeader());
    expect(crossTenantDetails.status).toBe(404);
    expect(crossTenantDetails.body.data).toBeUndefined();

    const renameResponse = await request(app)
      .patch(`/api/organization/${abcOrganizationId}/folders/${rootId}`)
      .set(authHeader())
      .send({ name: "Renamed Integration Root" });
    expect(renameResponse.status).toBe(200);
    expect(renameResponse.body.data.folder.name).toBe("Renamed Integration Root");

    const file = await prisma.file.create({
      data: {
        organizationId: abcOrganizationId,
        ownerId: userId,
        folderId: rootId,
        originalName: "integration.txt",
        storedName: "integration-stored.txt",
        storageKey: `private/${fixtureSuffix}/integration.txt`,
        mimeType: "text/plain",
        size: 1n,
      },
      select: { id: true },
    });
    fileIds.push(file.id);

    await expect(
      prisma.file.create({
        data: {
          organizationId: abcOrganizationId,
          ownerId: userId,
          folderId: xyzRootId,
          originalName: "invalid.txt",
          storedName: "invalid-stored.txt",
          storageKey: `private/${fixtureSuffix}/invalid.txt`,
          mimeType: "text/plain",
          size: 1n,
        },
      })
    ).rejects.toThrow();

    const folderWithFileResponse = await request(app)
      .delete(`/api/organization/${abcOrganizationId}/folders/${rootId}`)
      .set(authHeader());
    expect(folderWithFileResponse.status).toBe(409);

    await prisma.file.deleteMany({ where: { id: file.id } });
    fileIds.splice(fileIds.indexOf(file.id), 1);

    const folderWithChildResponse = await request(app)
      .delete(`/api/organization/${abcOrganizationId}/folders/${rootId}`)
      .set(authHeader());
    expect(folderWithChildResponse.status).toBe(409);

    const deleteChildResponse = await request(app)
      .delete(`/api/organization/${abcOrganizationId}/folders/${childId}`)
      .set(authHeader());
    expect(deleteChildResponse.status).toBe(200);
    folderIds.splice(folderIds.indexOf(childId), 1);

    const deleteRootResponse = await request(app)
      .delete(`/api/organization/${abcOrganizationId}/folders/${rootId}`)
      .set(authHeader());
    expect(deleteRootResponse.status).toBe(200);
    folderIds.splice(folderIds.indexOf(rootId), 1);

    const deleteXyzRootResponse = await request(app)
      .delete(`/api/organization/${xyzOrganizationId}/folders/${xyzRootId}`)
      .set(authHeader());
    expect(deleteXyzRootResponse.status).toBe(200);
    folderIds.splice(folderIds.indexOf(xyzRootId), 1);
  });
});
