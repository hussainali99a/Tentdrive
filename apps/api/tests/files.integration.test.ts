import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import request from "supertest";

const runIntegrationTests =
  process.env.TENANTDRIVE_RUN_DB_INTEGRATION === "1";
const integrationDescribe = runIntegrationTests ? describe : describe.skip;
const fixtureSuffix = randomUUID().replace(/-/g, "");

let app: (typeof import("../src/app.js"))["default"];
let prisma: (typeof import("../src/lib/prisma.js"))["prisma"];
let userId: string;
let otherUserId: string;
let organizationId: string;
let otherOrganizationId: string;
let folderId: string;
let otherOrganizationFolderId: string;
let uploadedFileId: string;
let storageDirectory: string;
const fileIds: string[] = [];
const uploadedContents = Buffer.from(
  "%PDF-1.7\nDatabase integration test\n%%EOF\n",
);

function authHeader(actorId = userId) {
  return {
    Authorization: `Bearer ${jwt.sign(
      { sub: actorId },
      process.env.JWT_SECRET as string,
    )}`,
  };
}

integrationDescribe("file uploads (database integration)", () => {
  beforeAll(async () => {
    const selectedTestDatabase = process.env.TENANTDRIVE_TEST_DATABASE_URL;

    if (selectedTestDatabase) {
      const databaseName = new URL(selectedTestDatabase).pathname.replace(
        /^\//,
        "",
      );
      if (!/test/i.test(databaseName)) {
        throw new Error(
          "TENANTDRIVE_TEST_DATABASE_URL must point to a database with 'test' in its name",
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
          "Without TENANTDRIVE_TEST_DATABASE_URL, explicitly allow only the local tenantdrive database",
        );
      }
    }

    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is not configured");
    }

    storageDirectory = await mkdtemp(
      join(tmpdir(), "tenantdrive-file-integration-"),
    );
    process.env.STORAGE_DIR = storageDirectory;

    const [{ default: loadedApp }, { prisma: loadedPrisma }] = await Promise.all([
      import("../src/app.js"),
      import("../src/lib/prisma.js"),
    ]);
    app = loadedApp;
    prisma = loadedPrisma;

    const user = await prisma.user.create({
      data: {
        email: `tenantdrive-file-it-${fixtureSuffix}@example.test`,
        name: "TenantDrive File Integration User",
        passwordHash: "integration-fixture-password-hash",
      },
      select: { id: true },
    });
    userId = user.id;
    const otherUser = await prisma.user.create({
      data: {
        email: `tenantdrive-file-other-it-${fixtureSuffix}@example.test`,
        name: "TenantDrive File Integration Other User",
        passwordHash: "integration-fixture-password-hash",
      },
      select: { id: true },
    });
    otherUserId = otherUser.id;

    const organization = await prisma.organization.create({
      data: {
        name: `TenantDrive File Integration ${fixtureSuffix}`,
        slug: `tenantdrive-file-it-${fixtureSuffix}`,
      },
      select: { id: true },
    });
    organizationId = organization.id;
    const otherOrganization = await prisma.organization.create({
      data: {
        name: `TenantDrive Other File Integration ${fixtureSuffix}`,
        slug: `tenantdrive-other-file-it-${fixtureSuffix}`,
      },
      select: { id: true },
    });
    otherOrganizationId = otherOrganization.id;

    await prisma.membership.create({
      data: {
        organizationId,
        userId,
        role: "MEMBER",
        status: "ACTIVE",
      },
    });
    await prisma.membership.create({
      data: {
        organizationId,
        userId: otherUserId,
        role: "MEMBER",
        status: "ACTIVE",
      },
    });
    const folder = await prisma.folder.create({
      data: {
        organizationId,
        ownerId: userId,
        name: "Upload Integration Folder",
      },
      select: { id: true },
    });
    folderId = folder.id;
    const foreignFolder = await prisma.folder.create({
      data: {
        organizationId: otherOrganizationId,
        ownerId: userId,
        name: "Foreign Upload Integration Folder",
      },
      select: { id: true },
    });
    otherOrganizationFolderId = foreignFolder.id;
  });

  afterAll(async () => {
    try {
      if (!prisma) return;

      if (fileIds.length) {
        const files = await prisma.file.findMany({
          where: { id: { in: fileIds } },
          select: { storageKey: true },
        });
        for (const file of files) {
          await rm(join(storageDirectory, "private", file.storageKey), {
            force: true,
          });
        }
        await prisma.file.deleteMany({
          where: { id: { in: fileIds } },
        });
      }

      if (folderId || otherOrganizationFolderId) {
        await prisma.folder.deleteMany({
          where: {
            id: { in: [folderId, otherOrganizationFolderId].filter(Boolean) },
          },
        });
      }
      if (userId) {
        await prisma.membership.deleteMany({
          where: { userId: { in: [userId, otherUserId].filter(Boolean) } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: [userId, otherUserId].filter(Boolean) } },
        });
      }
      if (organizationId || otherOrganizationId) {
        await prisma.organization.deleteMany({
          where: {
            id: { in: [organizationId, otherOrganizationId].filter(Boolean) },
          },
        });
      }
    } finally {
      if (prisma) await prisma.$disconnect();
      if (storageDirectory) {
        await rm(storageDirectory, { recursive: true, force: true });
      }
    }
  });

  it("persists an organization-scoped upload with authenticated ownership and private storage", async () => {
    const response = await request(app)
      .post(`/api/organization/${organizationId}/files/upload`)
      .set(authHeader())
      .field("folderId", folderId)
      .attach("file", uploadedContents, {
        filename: "integration-report.pdf",
        contentType: "application/pdf",
      });

    expect(response.status).toBe(201);
    const publicFile = response.body.data.file;
    fileIds.push(publicFile.id);
    expect(publicFile).toMatchObject({
      organizationId,
      ownerId: userId,
      folderId,
      originalName: "integration-report.pdf",
      mimeType: "application/pdf",
      size: uploadedContents.length,
    });
    uploadedFileId = publicFile.id;
    expect(JSON.stringify(response.body)).not.toContain("storageKey");
    expect(JSON.stringify(response.body)).not.toContain("storedName");

    const storedFile = await prisma.file.findUnique({
      where: { id: publicFile.id },
      select: { storageKey: true, checksum: true },
    });
    expect(storedFile).not.toBeNull();
    expect(storedFile?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await readFile(join(storageDirectory, "private", storedFile!.storageKey)),
    ).toEqual(uploadedContents);
  });

  it("lists and downloads an owner's file while denying same-organization non-owners", async () => {
    const rootList = await request(app)
      .get(`/api/organization/${organizationId}/files?folderId=null`)
      .set(authHeader());
    expect(rootList.status).toBe(200);
    expect(rootList.body.data.files).toEqual([]);

    const folderList = await request(app)
      .get(`/api/organization/${organizationId}/files?folderId=${folderId}`)
      .set(authHeader());
    expect(folderList.status).toBe(200);
    expect(folderList.body.data.files.map((file: { id: string }) => file.id)).toContain(
      uploadedFileId,
    );

    const details = await request(app)
      .get(`/api/organization/${organizationId}/files/${uploadedFileId}`)
      .set(authHeader());
    expect(details.status).toBe(200);
    expect(details.body.data.file).toMatchObject({
      id: uploadedFileId,
      originalName: "integration-report.pdf",
    });
    expect(JSON.stringify(details.body)).not.toContain("storageKey");
    expect(JSON.stringify(details.body)).not.toContain("storedName");

    const download = await request(app)
      .get(`/api/organization/${organizationId}/files/${uploadedFileId}/download`)
      .set(authHeader());
    expect(download.status).toBe(200);
    expect(Buffer.from(download.body)).toEqual(uploadedContents);

    const otherUserList = await request(app)
      .get(`/api/organization/${organizationId}/files`)
      .set(authHeader(otherUserId));
    const otherUserDetails = await request(app)
      .get(`/api/organization/${organizationId}/files/${uploadedFileId}`)
      .set(authHeader(otherUserId));
    const otherUserDownload = await request(app)
      .get(`/api/organization/${organizationId}/files/${uploadedFileId}/download`)
      .set(authHeader(otherUserId));
    const missingFileId = `missing-${fixtureSuffix}`;
    const missingDetails = await request(app)
      .get(`/api/organization/${organizationId}/files/${missingFileId}`)
      .set(authHeader(otherUserId));
    const missingDownload = await request(app)
      .get(`/api/organization/${organizationId}/files/${missingFileId}/download`)
      .set(authHeader(otherUserId));

    expect(otherUserList.status).toBe(200);
    expect(otherUserList.body.data.files).toEqual([]);
    expect(otherUserDetails.status).toBe(404);
    expect(otherUserDownload.status).toBe(404);
    expect({
      status: otherUserDetails.status,
      body: otherUserDetails.body,
    }).toEqual({
      status: missingDetails.status,
      body: missingDetails.body,
    });
    expect({
      status: otherUserDownload.status,
      body: otherUserDownload.body,
    }).toEqual({
      status: missingDownload.status,
      body: missingDownload.body,
    });

    const crossOrganization = await request(app)
      .get(
        `/api/organization/${otherOrganizationId}/files/${uploadedFileId}/download`,
      )
      .set(authHeader());
    expect(crossOrganization.status).toBe(403);
  });

  it("rejects a folder owned by another organization", async () => {
    const response = await request(app)
      .post(`/api/organization/${organizationId}/files/upload`)
      .set(authHeader())
      .field("folderId", otherOrganizationFolderId)
      .attach("file", Buffer.from("%PDF-1.7\nx"), {
        filename: "foreign.pdf",
        contentType: "application/pdf",
      });

    expect(response.status).toBe(404);
    expect(fileIds).toHaveLength(1);
  });

  it("rejects upload when the user has no membership in the selected organization", async () => {
    const response = await request(app)
      .post(`/api/organization/${otherOrganizationId}/files/upload`)
      .set(authHeader())
      .attach("file", Buffer.from("%PDF-1.7\nx"), {
        filename: "unauthorized.pdf",
        contentType: "application/pdf",
      });

    expect(response.status).toBe(403);
  });
});
