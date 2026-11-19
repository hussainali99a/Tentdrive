import { Router, type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { authenticateToken } from "../../middleware/auth.middleware.js";
import {
  requireOrganizationMembership,
  type OrganizationRequest,
} from "../../middleware/organization.middleware.js";
import {
  privateUploadStorage,
  openStoredUpload,
  removeStoredUpload,
  UnsafePrivateStoragePathError,
  UploadStorageError,
} from "./upload.storage.js";
import {
  inspectUploadedFile,
  MAX_UPLOAD_SIZE,
  UploadValidationError,
} from "./upload.validation.js";

const router = Router();

const upload = multer({
  storage: privateUploadStorage,
  limits: {
    fileSize: MAX_UPLOAD_SIZE,
    files: 1,
    fields: 1,
    fieldSize: 255,
    parts: 2,
  },
});

const fieldsSchema = z
  .object({
    folderId: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

const listFilesSchema = z.object({
  folderId: z.string().trim().min(1).max(255).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const fileIdSchema = z.string().trim().min(1).max(255);

const fileResponseSelect = {
  id: true,
  organizationId: true,
  ownerId: true,
  folderId: true,
  originalName: true,
  mimeType: true,
  size: true,
  checksum: true,
  createdAt: true,
  updatedAt: true,
} as const;

const fileMetadataSelect = {
  id: true,
  originalName: true,
  mimeType: true,
  size: true,
  checksum: true,
  folderId: true,
  createdAt: true,
  updatedAt: true,
} as const;

function serializeFile<T extends { size: bigint }>(file: T) {
  return { ...file, size: Number(file.size) };
}

function getFileId(req: OrganizationRequest): string | null {
  const validation = fileIdSchema.safeParse(req.params.fileId);
  return validation.success ? validation.data : null;
}

function getSafeAttachmentFilename(originalName: string): string {
  const filename = originalName
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 255);
  return filename && filename !== "." && filename !== ".."
    ? filename
    : "download";
}

function getSafeContentType(mimeType: string): string {
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mimeType)
    ? mimeType
    : "application/octet-stream";
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function parseMultipartUpload(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  upload.single("file")(req, res, (error: unknown) => {
    if (!error) return next();

    if (error instanceof MulterError) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        success: false,
        message: tooLarge
          ? "File exceeds the 25 MB upload limit"
          : "Invalid multipart upload",
      });
    }

    if (error instanceof UploadStorageError) {
      console.error("Private upload storage failed");
      return res.status(500).json({
        success: false,
        message: "Unable to store uploaded file",
      });
    }

    return res.status(400).json({
      success: false,
      message: "Malformed multipart upload",
    });
  });
}

async function removeUpload(filename: string | undefined): Promise<boolean> {
  if (!filename) return true;
  try {
    await removeStoredUpload(filename);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return true;
    }
    console.error(
      "Uploaded file cleanup failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return false;
  }
}

router.post(
  "/:organizationId/files/upload",
  authenticateToken,
  requireOrganizationMembership,
  parseMultipartUpload,
  async (req: OrganizationRequest, res) => {
    const uploadedFile = req.file;
    if (!uploadedFile) {
      return res.status(400).json({
        success: false,
        message: "A file is required",
      });
    }

    const fields = fieldsSchema.safeParse(req.body);
    if (!fields.success) {
      const removed = await removeUpload(uploadedFile.filename);
      if (!removed) {
        return res.status(500).json({
          success: false,
          message: "Upload failed and temporary file cleanup requires attention",
        });
      }
      return res.status(400).json({
        success: false,
        message: "Invalid upload fields",
        errors: fields.error.flatten(),
      });
    }

    const organizationId = req.organizationId;
    const ownerId = req.userId;
    if (!organizationId || !ownerId) {
      const removed = await removeUpload(uploadedFile.filename);
      if (!removed) {
        return res.status(500).json({
          success: false,
          message: "Upload failed and temporary file cleanup requires attention",
        });
      }
      return res.status(401).json({
        success: false,
        message: "Authentication and organization membership are required",
      });
    }

    const originalName = uploadedFile.originalname;
    if (
      !originalName ||
      originalName.length > 255 ||
      /[\\/\u0000-\u001f\u007f]/.test(originalName)
    ) {
      const removed = await removeUpload(uploadedFile.filename);
      if (!removed) {
        return res.status(500).json({
          success: false,
          message: "Upload failed and temporary file cleanup requires attention",
        });
      }
      return res.status(400).json({
        success: false,
        message: "The original filename is invalid",
      });
    }

    const extension = originalName.slice(originalName.lastIndexOf(".")).toLowerCase();
    try {
      const inspected = await inspectUploadedFile(uploadedFile.path, extension);

      if (fields.data.folderId) {
        const folder = await prisma.folder.findFirst({
          where: {
            id: fields.data.folderId,
            organizationId,
          },
          select: { id: true },
        });
        if (!folder) {
          const removed = await removeUpload(uploadedFile.filename);
          if (!removed) {
            return res.status(500).json({
              success: false,
              message: "Upload failed and temporary file cleanup requires attention",
            });
          }
          return res.status(404).json({
            success: false,
            message: "Destination folder not found in this organization",
          });
        }
      }

      const file = await prisma.file.create({
        data: {
          organizationId,
          ownerId,
          folderId: fields.data.folderId ?? null,
          originalName,
          storedName: uploadedFile.filename,
          storageKey: uploadedFile.filename,
          mimeType: inspected.mimeType,
          size: BigInt(inspected.size),
          checksum: inspected.checksum,
        },
        select: fileResponseSelect,
      });

      const publicFile = {
        id: file.id,
        organizationId: file.organizationId,
        ownerId: file.ownerId,
        folderId: file.folderId,
        originalName: file.originalName,
        mimeType: file.mimeType,
        size: Number(file.size),
        checksum: file.checksum,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
      };

      return res.status(201).json({
        success: true,
        message: "File uploaded successfully",
        data: { file: publicFile },
      });
    } catch (error) {
      const removed = await removeUpload(uploadedFile.filename);
      if (error instanceof UploadValidationError) {
        if (!removed) {
          return res.status(500).json({
            success: false,
            message: "Upload failed and temporary file cleanup requires attention",
          });
        }
        return res.status(400).json({
          success: false,
          message: error.message,
        });
      }

      console.error(
        "File upload failed:",
        error instanceof Error ? error.name : "Unknown error",
      );
      return res.status(500).json({
        success: false,
        message: removed
          ? "Unable to upload file"
          : "Upload failed and temporary file cleanup requires attention",
      });
    }
  },
);

router.get(
  "/:organizationId/files",
  authenticateToken,
  requireOrganizationMembership,
  async (req: OrganizationRequest, res) => {
    const validation = listFilesSchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid file list parameters",
        errors: validation.error.flatten(),
      });
    }

    const organizationId = req.organizationId;
    const ownerId = req.userId;
    if (!organizationId || !ownerId) {
      return res.status(401).json({
        success: false,
        message: "Authentication and organization membership are required",
      });
    }

    const { page, limit } = validation.data;
    const requestedFolderId = validation.data.folderId;
    const folderId =
      requestedFolderId === undefined || requestedFolderId === "null"
        ? null
        : requestedFolderId;

    try {
      if (folderId) {
        const folder = await prisma.folder.findFirst({
          where: { id: folderId, organizationId },
          select: { id: true },
        });
        if (!folder) {
          return res.status(404).json({
            success: false,
            message: "Folder not found",
          });
        }
      }

      const where = { organizationId, ownerId, folderId };
      const [files, total] = await Promise.all([
        prisma.file.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          skip: (page - 1) * limit,
          take: limit,
          select: fileMetadataSelect,
        }),
        prisma.file.count({ where }),
      ]);

      return res.status(200).json({
        success: true,
        data: {
          files: files.map(serializeFile),
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      console.error(
        "File listing failed:",
        error instanceof Error ? error.name : "Unknown error",
      );
      return res.status(500).json({
        success: false,
        message: "Unable to retrieve files",
      });
    }
  },
);

router.get(
  "/:organizationId/files/:fileId",
  authenticateToken,
  requireOrganizationMembership,
  async (req: OrganizationRequest, res) => {
    const organizationId = req.organizationId;
    const ownerId = req.userId;
    const fileId = getFileId(req);
    if (!fileId) {
      return res.status(400).json({
        success: false,
        message: "A valid file ID is required",
      });
    }
    if (!organizationId || !ownerId) {
      return res.status(401).json({
        success: false,
        message: "Authentication and organization membership are required",
      });
    }

    try {
      const file = await prisma.file.findFirst({
        where: { id: fileId, organizationId, ownerId },
        select: fileMetadataSelect,
      });
      if (!file) {
        return res.status(404).json({
          success: false,
          message: "File not found",
        });
      }

      return res.status(200).json({
        success: true,
        data: { file: serializeFile(file) },
      });
    } catch (error) {
      console.error(
        "File retrieval failed:",
        error instanceof Error ? error.name : "Unknown error",
      );
      return res.status(500).json({
        success: false,
        message: "Unable to retrieve file",
      });
    }
  },
);

router.get(
  "/:organizationId/files/:fileId/download",
  authenticateToken,
  requireOrganizationMembership,
  async (req: OrganizationRequest, res) => {
    const organizationId = req.organizationId;
    const ownerId = req.userId;
    const fileId = getFileId(req);
    if (!fileId) {
      return res.status(400).json({
        success: false,
        message: "A valid file ID is required",
      });
    }
    if (!organizationId || !ownerId) {
      return res.status(401).json({
        success: false,
        message: "Authentication and organization membership are required",
      });
    }

    try {
      const file = await prisma.file.findFirst({
        where: { id: fileId, organizationId, ownerId },
        select: {
          storageKey: true,
          storedName: true,
          originalName: true,
          mimeType: true,
        },
      });
      if (!file) {
        return res.status(404).json({
          success: false,
          message: "File not found",
        });
      }

      let stream;
      try {
        stream = await openStoredUpload(file.storageKey, file.storedName);
      } catch (error) {
        if (isNodeErrorCode(error, "ENOENT")) {
          return res.status(404).json({
            success: false,
            message: "File content is unavailable",
          });
        }
        if (error instanceof UnsafePrivateStoragePathError) {
          console.error("Unsafe private storage metadata was rejected");
          return res.status(500).json({
            success: false,
            message: "Unable to retrieve file",
          });
        }

        console.error(
          "Private file access failed:",
          error instanceof Error ? error.name : "Unknown error",
        );
        return res.status(500).json({
          success: false,
          message: "Unable to retrieve file",
        });
      }

      res.attachment(getSafeAttachmentFilename(file.originalName));
      res.setHeader("Content-Type", getSafeContentType(file.mimeType));
      res.setHeader("X-Content-Type-Options", "nosniff");
      stream.on("error", (error: Error) => {
        console.error("Private file stream failed:", error.name);
        if (res.headersSent) {
          res.destroy();
        } else {
          res.status(500).json({
            success: false,
            message: "Unable to retrieve file",
          });
        }
      });
      return stream.pipe(res);
    } catch (error) {
      console.error(
        "File download failed:",
        error instanceof Error ? error.name : "Unknown error",
      );
      return res.status(500).json({
        success: false,
        message: "Unable to retrieve file",
      });
    }
  },
);

export default router;
