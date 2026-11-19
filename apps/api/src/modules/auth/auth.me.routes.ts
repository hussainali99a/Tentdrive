import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import {
  authenticateToken,
  type AuthenticatedRequest,
} from "../../middleware/auth.middleware.js";

const router = Router();

router.get("/me", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        name: true,
        email: true,
        memberships: {
          where: { status: "ACTIVE" },
          select: {
            role: true,
            organization: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User account not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        organizations: user.memberships.map((membership) => ({
          ...membership.organization,
          role: membership.role,
        })),
      },
    });
  } catch (error) {
    console.error("Profile retrieval failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve user profile",
    });
  }
});

export default router;
