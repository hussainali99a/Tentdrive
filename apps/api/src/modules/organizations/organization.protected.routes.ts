import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { authenticateToken } from "../../middleware/auth.middleware.js";
import {
  requireOrganizationMembership,
  requireOrganizationAdmin,
  type OrganizationRequest,
} from "../../middleware/organization.middleware.js";

const router = Router();

router.get(
  "/:organizationId",
  authenticateToken,
  requireOrganizationMembership,
  async (req: OrganizationRequest, res) => {
    try {
      const organization = await prisma.organization.findUnique({
        where: {
          id: req.organizationId,
        },
        select: {
          id: true,
          name: true,
          slug: true,
          createdAt: true,
        },
      });

      if (!organization) {
        return res.status(404).json({
          success: false,
          message: "Organization not found",
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          organization,
          role: req.organizationRole,
        },
      });
    } catch (error) {
      console.error("Organization retrieval failed:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to retrieve organization",
      });
    }
  }
);

router.get(
  "/:organizationId/admin-check",
  authenticateToken,
  requireOrganizationMembership,
  requireOrganizationAdmin,
  (_req, res) => {
    return res.status(200).json({
      success: true,
      message: "Organization admin access verified",
    });
  }
);

export default router;
