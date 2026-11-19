import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const mocks = vi.hoisted(() => {
  const folder = { findFirst: vi.fn() };
  const file = {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
  };
  const membership = { findFirst: vi.fn() };
  return { prisma: { folder, file, membership } };
});

vi.mock("../src/lib/prisma.js", () => ({ prisma: mocks.prisma }));

import jwt from "jsonwebtoken";
import request from "supertest";
import app from "../src/app.js";

const organizationId = "org-one";
const otherOrganizationId = "org-two";
const userId = "user-one";
const otherUserId = "user-two";
const jwtSecret = "file-route-tests-secret";
const storedName = "a".repeat(64);
const pdfContents = Buffer.from("%PDF-1.7\nTenantDrive upload test\n%%EOF\n");
const pngContents = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf5sAAAAASUVORK5CYII=",
  "base64",
);
const jpegContents = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/If/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8B/8QAFBEBAAAAAAAAAAAAAAAAAAAAA//aAAgBAgEBPwH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/If/Z",
  "base64",
);

function crc32(contents: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: Array<{ name: string; contents: string }>): Buffer {
  let offset = 0;
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const contents = Buffer.from(entry.contents);
    const checksum = crc32(contents);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(contents.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localRecords.push(localHeader, name, contents);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(contents.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralRecords.push(centralHeader, name);
    offset += localHeader.length + name.length + contents.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, endRecord]);
}

let storageDirectory: string;

function authHeader(tokenUserId = userId) {
  return {
    Authorization: `Bearer ${jwt.sign({ sub: tokenUserId }, jwtSecret)}`,
  };
}

function endpoint(orgId = organizationId) {
  return `/api/organization/${orgId}/files/upload`;
}

function filesEndpoint(orgId = organizationId) {
  return `/api/organization/${orgId}/files`;
}

function makeFile(
  overrides: Partial<{
    id: string;
    originalName: string;
    mimeType: string;
    size: bigint;
    checksum: string | null;
    folderId: string | null;
  }> = {},
) {
  return {
    id: "file-one",
    originalName: "report.pdf",
    mimeType: "application/pdf",
    size: BigInt(pdfContents.length),
    checksum: "a".repeat(64),
    folderId: null,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    updatedAt: new Date("2026-01-02T03:04:05.000Z"),
    ...overrides,
  };
}

function makeStoredFile(
  overrides: Partial<{
    storageKey: string;
    storedName: string;
    originalName: string;
    mimeType: string;
  }> = {},
) {
  return {
    storageKey: storedName,
    storedName,
    originalName: "report.pdf",
    mimeType: "application/pdf",
    ...overrides,
  };
}

async function writeStoredFile(
  name = storedName,
  contents = pdfContents,
): Promise<void> {
  const privateDirectory = join(storageDirectory, "private");
  await mkdir(privateDirectory, { recursive: true });
  await writeFile(join(privateDirectory, name), contents);
}

function attachPdf(
  req: request.Test,
  filename = "report.pdf",
  contents = pdfContents,
) {
  return req.attach("file", contents, {
    filename,
    contentType: "application/pdf",
  });
}

describe("organization file uploads", () => {
  beforeEach(async () => {
    storageDirectory = await mkdtemp(join(tmpdir(), "tenantdrive-upload-test-"));
    process.env.STORAGE_DIR = storageDirectory;
    process.env.JWT_SECRET = jwtSecret;
    vi.clearAllMocks();

    mocks.prisma.membership.findFirst.mockImplementation(
      async ({ where }: { where: { userId: string; organizationId: string } }) =>
        where.organizationId === organizationId
          ? { organizationId, role: "MEMBER" }
          : null,
    );
    mocks.prisma.folder.findFirst.mockResolvedValue({ id: "folder-one" });
    mocks.prisma.file.findMany.mockResolvedValue([]);
    mocks.prisma.file.count.mockResolvedValue(0);
    mocks.prisma.file.findFirst.mockResolvedValue(null);
    mocks.prisma.file.create.mockImplementation(
      async ({
        data,
      }: {
        data: {
          organizationId: string;
          ownerId: string;
          folderId: string | null;
          originalName: string;
          mimeType: string;
          size: bigint;
          checksum: string;
        };
      }) => ({
        id: "file-one",
        ...data,
        createdAt: new Date("2026-01-02T03:04:05.000Z"),
        updatedAt: new Date("2026-01-02T03:04:05.000Z"),
      }),
    );
  });

  afterEach(async () => {
    await rm(storageDirectory, { recursive: true, force: true });
  });

  it("lists only the authenticated owner's root files", async () => {
    mocks.prisma.file.findMany.mockResolvedValue([makeFile()]);
    mocks.prisma.file.count.mockResolvedValue(1);

    const response = await request(app)
      .get(filesEndpoint())
      .set(authHeader());

    expect(response.status).toBe(200);
    expect(mocks.prisma.file.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId, ownerId: userId, folderId: null },
        skip: 0,
        take: 20,
      }),
    );
    expect(response.body.data.files).toHaveLength(1);
    expect(response.body.data.files[0]).toMatchObject({
      id: "file-one",
      originalName: "report.pdf",
      size: pdfContents.length,
      folderId: null,
    });
    expect(JSON.stringify(response.body)).not.toContain("storageKey");
    expect(JSON.stringify(response.body)).not.toContain("storedName");
  });

  it("lists owner files from a validated folder and returns empty folders", async () => {
    mocks.prisma.file.findMany.mockResolvedValue([
      makeFile({ folderId: "folder-one" }),
    ]);

    const populated = await request(app)
      .get(`${filesEndpoint()}?folderId=folder-one`)
      .set(authHeader());
    expect(populated.status).toBe(200);
    expect(mocks.prisma.file.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId, ownerId: userId, folderId: "folder-one" },
      }),
    );

    mocks.prisma.file.findMany.mockResolvedValue([]);
    mocks.prisma.file.count.mockResolvedValue(0);
    const empty = await request(app)
      .get(`${filesEndpoint()}?folderId=folder-one`)
      .set(authHeader());
    expect(empty.status).toBe(200);
    expect(empty.body.data.files).toEqual([]);
    expect(empty.body.data.pagination.total).toBe(0);
  });

  it("validates file list folder and pagination inputs", async () => {
    mocks.prisma.folder.findFirst.mockResolvedValueOnce(null);
    const invalidFolder = await request(app)
      .get(`${filesEndpoint()}?folderId=unknown-folder`)
      .set(authHeader());
    const invalidPagination = await request(app)
      .get(`${filesEndpoint()}?page=0&limit=101`)
      .set(authHeader());

    expect(invalidFolder.status).toBe(404);
    expect(invalidPagination.status).toBe(400);
    expect(mocks.prisma.file.findMany).not.toHaveBeenCalled();
  });

  it("paginates file results and enforces the maximum page size", async () => {
    mocks.prisma.file.findMany.mockResolvedValue([makeFile()]);
    mocks.prisma.file.count.mockResolvedValue(3);

    const response = await request(app)
      .get(`${filesEndpoint()}?page=2&limit=1`)
      .set(authHeader());

    expect(response.status).toBe(200);
    expect(mocks.prisma.file.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 1, take: 1 }),
    );
    expect(response.body.data.pagination).toEqual({
      page: 2,
      limit: 1,
      total: 3,
      totalPages: 3,
    });

    const tooMany = await request(app)
      .get(`${filesEndpoint()}?limit=101`)
      .set(authHeader());
    expect(tooMany.status).toBe(400);
  });

  it("returns safe details for the owner and hides another user's file", async () => {
    mocks.prisma.file.findFirst.mockResolvedValue(makeFile());

    const ownerResponse = await request(app)
      .get(`${filesEndpoint()}/file-one`)
      .set(authHeader());

    expect(ownerResponse.status).toBe(200);
    expect(ownerResponse.body.data.file).toMatchObject({
      id: "file-one",
      originalName: "report.pdf",
    });
    expect(JSON.stringify(ownerResponse.body)).not.toContain("storageKey");

    mocks.prisma.file.findFirst.mockResolvedValue(null);
    const otherOwnerResponse = await request(app)
      .get(`${filesEndpoint()}/private-file`)
      .set(authHeader(otherUserId));
    expect(otherOwnerResponse.status).toBe(404);
    expect(mocks.prisma.file.findFirst).toHaveBeenLastCalledWith({
      where: {
        id: "private-file",
        organizationId,
        ownerId: otherUserId,
      },
      select: expect.any(Object),
    });
  });

  it("streams owner file bytes with safe download headers", async () => {
    await writeStoredFile();
    mocks.prisma.file.findFirst.mockResolvedValue(makeStoredFile());

    const response = await request(app)
      .get(`${filesEndpoint()}/file-one/download`)
      .set(authHeader());

    expect(response.status).toBe(200);
    expect(Buffer.from(response.body)).toEqual(pdfContents);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("does not allow another organization member to view or download private files", async () => {
    const privateFile = makeFile({ id: "private-file" });
    mocks.prisma.file.findFirst.mockImplementation(
      async ({
        where,
        select,
      }: {
        where: {
          id: string;
          organizationId: string;
          ownerId: string;
        };
        select: { storageKey?: boolean };
      }) =>
        where.id === "private-file" &&
        where.organizationId === organizationId &&
        where.ownerId === userId
          ? select.storageKey
            ? makeStoredFile()
            : privateFile
          : null,
    );

    const details = await request(app)
      .get(`${filesEndpoint()}/private-file`)
      .set(authHeader(otherUserId));
    const missingDetails = await request(app)
      .get(`${filesEndpoint()}/missing-file`)
      .set(authHeader(otherUserId));
    const download = await request(app)
      .get(`${filesEndpoint()}/private-file/download`)
      .set(authHeader(otherUserId));
    const missingDownload = await request(app)
      .get(`${filesEndpoint()}/missing-file/download`)
      .set(authHeader(otherUserId));

    expect(details.status).toBe(404);
    expect({ status: details.status, body: details.body }).toEqual({
      status: missingDetails.status,
      body: missingDetails.body,
    });
    expect(download.status).toBe(404);
    expect({ status: download.status, body: download.body }).toEqual({
      status: missingDownload.status,
      body: missingDownload.body,
    });
    expect(details.body).toEqual({
      success: false,
      message: "File not found",
    });
    expect(download.body).toEqual(details.body);
    expect(mocks.prisma.membership.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId,
        userId: otherUserId,
        status: "ACTIVE",
      },
      select: { organizationId: true, role: true },
    });
    expect(mocks.prisma.file.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "private-file",
          organizationId,
          ownerId: otherUserId,
        },
      }),
    );
    expect(mocks.prisma.file.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "missing-file",
          organizationId,
          ownerId: otherUserId,
        },
      }),
    );
  });

  it("denies non-members and scopes cross-organization file lookups", async () => {
    mocks.prisma.membership.findFirst.mockResolvedValue(null);
    const nonMember = await request(app)
      .get(filesEndpoint(otherOrganizationId))
      .set(authHeader());
    expect(nonMember.status).toBe(403);
    expect(mocks.prisma.file.findMany).not.toHaveBeenCalled();

    mocks.prisma.membership.findFirst.mockResolvedValue({
      organizationId,
      role: "MEMBER",
    });
    const crossOrganization = await request(app)
      .get(`${filesEndpoint()}/foreign-file`)
      .set(authHeader());
    expect(crossOrganization.status).toBe(404);
    expect(mocks.prisma.file.findFirst).toHaveBeenLastCalledWith({
      where: {
        id: "foreign-file",
        organizationId,
        ownerId: userId,
      },
      select: expect.any(Object),
    });
  });

  it("requires authentication for listing, details, and downloads", async () => {
    const listing = await request(app).get(filesEndpoint());
    const details = await request(app).get(`${filesEndpoint()}/file-one`);
    const download = await request(app).get(
      `${filesEndpoint()}/file-one/download`,
    );

    expect(listing.status).toBe(401);
    expect(details.status).toBe(401);
    expect(download.status).toBe(401);
    expect(mocks.prisma.file.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.file.findFirst).not.toHaveBeenCalled();
  });

  it("rejects malformed file IDs without querying the database", async () => {
    const response = await request(app)
      .get(`${filesEndpoint()}/%20`)
      .set(authHeader());

    expect(response.status).toBe(400);
    expect(mocks.prisma.file.findFirst).not.toHaveBeenCalled();
  });

  it("returns a safe error when the physical file is missing", async () => {
    mocks.prisma.file.findFirst.mockResolvedValue(makeStoredFile());
    const response = await request(app)
      .get(`${filesEndpoint()}/file-one/download`)
      .set(authHeader());

    expect(response.status).toBe(404);
    expect(response.body.message).toBe("File content is unavailable");
    expect(JSON.stringify(response.body)).not.toContain(storageDirectory);
  });

  it("rejects unsafe storage metadata without exposing its value", async () => {
    mocks.prisma.file.findFirst.mockResolvedValue(
      makeStoredFile({
        storageKey: "../secret",
        storedName: "../secret",
      }),
    );

    const response = await request(app)
      .get(`${filesEndpoint()}/file-one/download`)
      .set(authHeader());

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("../secret");
    expect(JSON.stringify(response.body)).not.toContain(storageDirectory);
  });

  it("prevents malicious original filenames from injecting response headers", async () => {
    await writeStoredFile();
    mocks.prisma.file.findFirst.mockResolvedValue(
      makeStoredFile({
        originalName: "report.pdf\r\nX-Injected: yes",
      }),
    );

    const response = await request(app)
      .get(`${filesEndpoint()}/file-one/download`)
      .set(authHeader());

    expect(response.status).toBe(200);
    expect(response.headers["x-injected"]).toBeUndefined();
    expect(response.headers["content-disposition"]).not.toMatch(/[\r\n]/);
  });

  it("lists files only for the authenticated owner", async () => {
    mocks.prisma.file.findMany.mockResolvedValue([]);
    const response = await request(app)
      .get(filesEndpoint())
      .set(authHeader(otherUserId));

    expect(response.status).toBe(200);
    expect(response.body.data.files).toEqual([]);
    expect(mocks.prisma.file.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId, ownerId: otherUserId, folderId: null },
      }),
    );
  });

  it("requires authentication before accepting the upload", async () => {
    const response = await attachPdf(request(app).post(endpoint()));

    expect(response.status).toBe(401);
    expect(mocks.prisma.file.create).not.toHaveBeenCalled();
  });

  it("rejects users without active organization membership", async () => {
    mocks.prisma.membership.findFirst.mockResolvedValue(null);

    const response = await attachPdf(
      request(app).post(endpoint(otherOrganizationId)).set(authHeader()),
    );

    expect(response.status).toBe(403);
    expect(mocks.prisma.file.create).not.toHaveBeenCalled();
  });

  it("uploads a PDF, uses authenticated ownership, and returns only public metadata", async () => {
    const response = await attachPdf(
      request(app).post(endpoint()).set(authHeader()),
      "annual-report.pdf",
    );

    expect(response.status).toBe(201);
    expect(response.body.data.file).toMatchObject({
      organizationId,
      ownerId: userId,
      folderId: null,
      originalName: "annual-report.pdf",
      mimeType: "application/pdf",
      size: pdfContents.length,
    });
    expect(response.body.data.file.checksum).toMatch(/^[a-f0-9]{64}$/);

    const createCall = mocks.prisma.file.create.mock.calls[0][0];
    expect(createCall.data).toMatchObject({
      organizationId,
      ownerId: userId,
      originalName: "annual-report.pdf",
      storageKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      storedName: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(createCall.data.size).toBe(BigInt(pdfContents.length));
    expect(createCall.data.checksum).toBe(response.body.data.file.checksum);
    expect(JSON.stringify(response.body)).not.toContain("storageKey");
    expect(JSON.stringify(response.body)).not.toContain("storedName");
    expect(JSON.stringify(response.body)).not.toContain(storageDirectory);

    const storedFilePath = join(
      storageDirectory,
      "private",
      createCall.data.storageKey,
    );
    const publicDirectory = resolve(process.cwd(), "..", "web", "public");
    const relativeToPublic = relative(publicDirectory, storedFilePath);
    const storedInsidePublic =
      relativeToPublic === "" ||
      (!isAbsolute(relativeToPublic) &&
        relativeToPublic !== ".." &&
        !relativeToPublic.startsWith(`..${sep}`));
    expect(storedInsidePublic).toBe(false);
    expect(await readFile(storedFilePath)).toEqual(pdfContents);
  });

  it.each([
    ["PNG", "pixel.png", pngContents, "image/png"],
    ["JPEG", "pixel.jpg", jpegContents, "image/jpeg"],
  ])("accepts valid %s image content", async (_label, filename, contents, mimeType) => {
    const response = await request(app)
      .post(endpoint())
      .set(authHeader())
      .attach("file", contents, { filename, contentType: mimeType });

    expect(response.status).toBe(201);
    expect(response.body.data.file.mimeType).toBe(mimeType);
  });

  it.each([
    ["text/plain", "notes.txt", "UTF-8 text content\n"],
    ["text/csv", "data.csv", "name,value\nsample,1\n"],
  ])("accepts supported text file %s", async (mimeType, filename, contents) => {
    const response = await request(app)
      .post(endpoint())
      .set(authHeader())
      .attach("file", Buffer.from(contents), { filename, contentType: mimeType });

    expect(response.status).toBe(201);
    expect(response.body.data.file.mimeType).toBe(mimeType);
  });

  it.each([
    [
      "document.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      createZip([
        {
          name: "[Content_Types].xml",
          contents:
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        },
        {
          name: "word/document.xml",
          contents:
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
        },
      ]),
    ],
    [
      "workbook.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      createZip([
        {
          name: "[Content_Types].xml",
          contents:
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        },
        {
          name: "xl/workbook.xml",
          contents:
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
        },
      ]),
    ],
  ])("accepts a supported Office document: %s", async (filename, mimeType, contents) => {
    const response = await request(app)
      .post(endpoint())
      .set(authHeader())
      .attach("file", contents, { filename, contentType: mimeType });

    expect(response.status).toBe(201);
    expect(response.body.data.file.mimeType).toBe(mimeType);
  });

  it("rejects unsupported extensions and content that does not match the extension", async () => {
    const unsupported = await attachPdf(
      request(app).post(endpoint()).set(authHeader()),
      "payload.exe",
    );
    const mismatch = await request(app)
      .post(endpoint())
      .set(authHeader())
      .attach("file", pngContents, {
        filename: "image.pdf",
        contentType: "application/pdf",
      });

    expect(unsupported.status).toBe(400);
    expect(mismatch.status).toBe(400);
    expect(mocks.prisma.file.create).not.toHaveBeenCalled();
  });

  it("rejects files larger than 25 MB", async () => {
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1, 0x41);
    const response = await attachPdf(
      request(app).post(endpoint()).set(authHeader()),
      "large.pdf",
      oversized,
    );

    expect(response.status).toBe(413);
    expect(response.body.message).toMatch(/25 MB/);
    expect(mocks.prisma.file.create).not.toHaveBeenCalled();
  });

  it("rejects empty files and requests without a file", async () => {
    const empty = await attachPdf(
      request(app).post(endpoint()).set(authHeader()),
      "empty.pdf",
      Buffer.alloc(0),
    );
    const missing = await request(app)
      .post(endpoint())
      .set(authHeader())
      .field("folderId", "folder-one");

    expect(empty.status).toBe(400);
    expect(empty.body.message).toMatch(/Empty files/);
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/file is required/i);
  });

  it("rejects a folder from another organization", async () => {
    mocks.prisma.folder.findFirst.mockResolvedValue(null);

    const response = await request(app)
      .post(endpoint())
      .set(authHeader())
      .field("folderId", "foreign-folder")
      .attach("file", pdfContents, {
        filename: "report.pdf",
        contentType: "application/pdf",
      });

    expect(response.status).toBe(404);
    expect(mocks.prisma.folder.findFirst).toHaveBeenCalledWith({
      where: { id: "foreign-folder", organizationId },
      select: { id: true },
    });
    expect(mocks.prisma.file.create).not.toHaveBeenCalled();
    expect(await readdir(join(storageDirectory, "private"))).toEqual([]);
  });

  it("rejects a nonexistent destination folder", async () => {
    mocks.prisma.folder.findFirst.mockResolvedValue(null);

    const response = await request(app)
      .post(endpoint())
      .set(authHeader())
      .field("folderId", "missing-folder")
      .attach("file", pdfContents, {
        filename: "report.pdf",
        contentType: "application/pdf",
      });

    expect(response.status).toBe(404);
    expect(mocks.prisma.folder.findFirst).toHaveBeenCalledWith({
      where: { id: "missing-folder", organizationId },
      select: { id: true },
    });
    expect(mocks.prisma.file.create).not.toHaveBeenCalled();
  });

  it("stores different uploads under unique random names", async () => {
    const first = await attachPdf(
      request(app).post(endpoint()).set(authHeader()),
      "same-name.pdf",
    );
    const second = await attachPdf(
      request(app).post(endpoint()).set(authHeader()),
      "same-name.pdf",
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstKey = mocks.prisma.file.create.mock.calls[0][0].data.storageKey;
    const secondKey = mocks.prisma.file.create.mock.calls[1][0].data.storageKey;
    expect(firstKey).not.toBe(secondKey);
    expect(await readdir(join(storageDirectory, "private"))).toHaveLength(2);
  });

  it("removes the stored upload when database creation fails", async () => {
    mocks.prisma.file.create.mockRejectedValue(new Error("database unavailable"));

    const response = await attachPdf(
      request(app).post(endpoint()).set(authHeader()),
    );

    expect(response.status).toBe(500);
    expect(await readdir(join(storageDirectory, "private"))).toEqual([]);
  });

  it("refuses a configured storage directory inside public web assets", async () => {
    const publicStorage = resolve(
      process.cwd(),
      "..",
      "web",
      "public",
      `upload-test-storage-${randomUUID()}`,
    );
    process.env.STORAGE_DIR = publicStorage;

    const response = await attachPdf(
      request(app).post(endpoint()).set(authHeader()),
    );

    expect(response.status).toBe(500);
    await expect(readdir(join(publicStorage, "private"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects client-supplied ownership and organization fields", async () => {
    const response = await request(app)
      .post(endpoint())
      .set(authHeader())
      .field("ownerId", otherUserId)
      .field("organizationId", otherOrganizationId)
      .attach("file", pdfContents, {
        filename: "report.pdf",
        contentType: "application/pdf",
      });

    expect(response.status).toBe(400);
    expect(mocks.prisma.file.create).not.toHaveBeenCalled();
  });
});
