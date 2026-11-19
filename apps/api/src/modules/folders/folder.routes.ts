import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { authenticateToken } from "../../middleware/auth.middleware.js";
import {
  requireOrganizationMembership,
  type OrganizationRequest,
} from "../../middleware/organization.middleware.js";

const router = Router();

const folderNameSchema = z.string().trim().min(1).max(255);

const createFolderSchema = z
  .object({
    name: folderNameSchema,
    parentId: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

const renameFolderSchema = z.object({ name: folderNameSchema }).strict();

const listFoldersSchema = z.object({
  parentId: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const folderSelect = {
  id: true,
  organizationId: true,
  ownerId: true,
  name: true,
  parentId: true,
  createdAt: true,
  updatedAt: true,
} as const;

function isPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function getFolderId(req: OrganizationRequest): string | null {
  const folderId = req.params.folderId;
  return typeof folderId === "string" && folderId.trim()
    ? folderId
    : null;
}

router.post(
  "/:organizationId/folders",
  authenticateToken,
  requireOrganizationMembership,
  async (req: OrganizationRequest, res) => {
    const validation = createFolderSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid folder data",
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

    const parentId = validation.data.parentId ?? null;

    try {
      if (parentId) {
        const parent = await prisma.folder.findFirst({
          where: { id: parentId, organizationId },
          select: { id: true },
        });

        if (!parent) {
          return res.status(404).json({
            success: false,
            message: "Parent folder not found in this organization",
          });
        }
      }

      const folder = await prisma.folder.create({
        data: {
          organizationId,
          ownerId,
          name: validation.data.name,
          parentId,
        },
        select: folderSelect,
      });

      return res.status(201).json({
        success: true,
        message: "Folder created successfully",
        data: { folder },
      });
    } catch (error) {
      if (isPrismaErrorCode(error, "P2003")) {
        return res.status(409).json({
          success: false,
          message: "The parent folder changed. Please retry the request.",
        });
      }

      console.error("Folder creation failed:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to create folder",
      });
    }
  }
);

router.get(
  "/:organizationId/folders",
  authenticateToken,
  requireOrganizationMembership,
  async (req: OrganizationRequest, res) => {
    const validation = listFoldersSchema.safeParse(req.query);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid folder list parameters",
        errors: validation.error.flatten(),
      });
    }

    const organizationId = req.organizationId;
    if (!organizationId) {
      return res.status(403).json({
        success: false,
        message: "Organization membership is required",
      });
    }

    const { page, limit } = validation.data;
    // Omit parentId or pass parentId=null to list root folders.
    const parentId =
      validation.data.parentId === undefined ||
      validation.data.parentId === "null"
        ? null
        : validation.data.parentId;

    try {
      if (parentId) {
        const parent = await prisma.folder.findFirst({
          where: { id: parentId, organizationId },
          select: { id: true },
        });

        if (!parent) {
          return res.status(404).json({
            success: false,
            message: "Parent folder not found in this organization",
          });
        }
      }

      const where = { organizationId, parentId };
      const [folders, total] = await Promise.all([
        prisma.folder.findMany({
          where,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          skip: (page - 1) * limit,
          take: limit,
          select: folderSelect,
        }),
        prisma.folder.count({ where }),
      ]);

      return res.status(200).json({
        success: true,
        data: {
          folders,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      console.error("Folder listing failed:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to retrieve folders",
      });
    }
  }
);

router.get(
  "/:organizationId/folders/:folderId",
  authenticateToken,
  requireOrganizationMembership,
  async (req: OrganizationRequest, res) => {
    const organizationId = req.organizationId;
    const folderId = getFolderId(req);

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        message: "Organization membership is required",
      });
    }
    if (!folderId) {
      return res.status(400).json({
        success: false,
        message: "A valid folder ID is required",
      });
    }

    try {
      const folder = await prisma.folder.findFirst({
        where: { id: folderId, organizationId },
        select: folderSelect,
      });

      if (!folder) {
        return res.status(404).json({
          success: false,
          message: "Folder not found",
        });
      }

      return res.status(200).json({
        success: true,
        data: { folder },
      });
    } catch (error) {
      console.error("Folder retrieval failed:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to retrieve folder",
      });
    }
  }
);

router.patch(
  "/:organizationId/folders/:folderId",
  authenticateToken,
  requireOrganizationMembership,
  async (req: OrganizationRequest, res) => {
    const validation = renameFolderSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid folder data",
        errors: validation.error.flatten(),
      });
    }

    const organizationId = req.organizationId;
    const ownerId = req.userId;
    const folderId = getFolderId(req);

    if (!organizationId || !ownerId) {
      return res.status(401).json({
        success: false,
        message: "Authentication and organization membership are required",
      });
    }
    if (!folderId) {
      return res.status(400).json({
        success: false,
        message: "A valid folder ID is required",
      });
    }

    try {
      const folder = await prisma.folder.findFirst({
        where: { id: folderId, organizationId },
        select: { ownerId: true },
      });

      if (!folder) {
        return res.status(404).json({
          success: false,
          message: "Folder not found",
        });
      }
      if (folder.ownerId !== ownerId) {
        return res.status(403).json({
          success: false,
          message: "Only the folder owner can rename it",
        });
      }

      const update = await prisma.folder.updateMany({
        where: { id: folderId, organizationId, ownerId },
        data: { name: validation.data.name },
      });

      if (update.count === 0) {
        return res.status(404).json({
          success: false,
          message: "Folder not found",
        });
      }

      const updatedFolder = await prisma.folder.findFirst({
        where: { id: folderId, organizationId },
        select: folderSelect,
      });

      if (!updatedFolder) {
        return res.status(404).json({
          success: false,
          message: "Folder not found",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Folder renamed successfully",
        data: { folder: updatedFolder },
      });
    } catch (error) {
      console.error("Folder rename failed:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to rename folder",
      });
    }
  }
);

router.delete(
  "/:organizationId/folders/:folderId",
  authenticateToken,
  requireOrganizationMembership,
  async (req: OrganizationRequest, res) => {
    const organizationId = req.organizationId;
    const ownerId = req.userId;
    const folderId = getFolderId(req);

    if (!organizationId || !ownerId) {
      return res.status(401).json({
        success: false,
        message: "Authentication and organization membership are required",
      });
    }
    if (!folderId) {
      return res.status(400).json({
        success: false,
        message: "A valid folder ID is required",
      });
    }

    try {
      const result = await prisma.$transaction(
        async (transaction) => {
          const folder = await transaction.folder.findFirst({
            where: { id: folderId, organizationId },
            select: { ownerId: true },
          });

          if (!folder) return { kind: "not_found" as const };
          if (folder.ownerId !== ownerId) {
            return { kind: "forbidden" as const };
          }

          const [childFolders, files] = await Promise.all([
            transaction.folder.count({
              where: { organizationId, parentId: folderId },
            }),
            transaction.file.count({
              where: { organizationId, folderId },
            }),
          ]);

          if (childFolders > 0 || files > 0) {
            return { kind: "not_empty" as const };
          }

          const deleted = await transaction.folder.deleteMany({
            where: { id: folderId, organizationId, ownerId },
          });

          return deleted.count === 1
            ? { kind: "deleted" as const }
            : { kind: "not_found" as const };
        },
        { isolationLevel: "Serializable" }
      );

      if (result.kind === "not_found") {
        return res.status(404).json({
          success: false,
          message: "Folder not found",
        });
      }
      if (result.kind === "forbidden") {
        return res.status(403).json({
          success: false,
          message: "Only the folder owner can delete it",
        });
      }
      if (result.kind === "not_empty") {
        return res.status(409).json({
          success: false,
          message: "Folder must not contain files or child folders",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Folder deleted successfully",
      });
    } catch (error) {
      if (
        isPrismaErrorCode(error, "P2003") ||
        isPrismaErrorCode(error, "P2034")
      ) {
        return res.status(409).json({
          success: false,
          message: "Folder contents changed. Refresh and retry the request.",
        });
      }

      console.error("Folder deletion failed:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to delete folder",
      });
    }
  }
);

export default router;
