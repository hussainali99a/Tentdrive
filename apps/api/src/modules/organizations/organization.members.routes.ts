import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import { prisma } from "../../lib/prisma.js";
import { authenticateToken } from "../../middleware/auth.middleware.js";
import {
  requireOrganizationAdmin,
  requireOrganizationMembership,
  type OrganizationRequest,
} from "../../middleware/organization.middleware.js";

const router = Router();

const roleSchema = z.enum(["ADMIN", "MEMBER"]);

const addExistingMemberSchema = z.object({
  email: z.string().trim().email().max(255).transform((email) => email.toLowerCase()),
  role: roleSchema,
});

const createMemberSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(255).transform((email) => email.toLowerCase()),
  password: z.string().min(12).max(128),
  role: roleSchema,
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const updateStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"]),
});

const memberSelect = {
  userId: true,
  role: true,
  status: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
} as const;

function toMemberResponse(membership: {
  userId: string;
  role: "ADMIN" | "MEMBER";
  status: "ACTIVE" | "INVITED" | "SUSPENDED";
  createdAt: Date;
  user: { id: string; name: string | null; email: string };
}) {
  return {
    userId: membership.userId,
    name: membership.user.name,
    email: membership.user.email,
    role: membership.role,
    status: membership.status,
    createdAt: membership.createdAt,
  };
}

function isPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

router.post(
  "/:organizationId/members",
  authenticateToken,
  requireOrganizationMembership,
  requireOrganizationAdmin,
  async (req: OrganizationRequest, res) => {
    const validation = addExistingMemberSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid member data",
        errors: validation.error.flatten(),
      });
    }

    try {
      const user = await prisma.user.findUnique({
        where: { email: validation.data.email },
        select: { id: true },
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      const existingMembership = await prisma.membership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: req.organizationId!,
            userId: user.id,
          },
        },
        select: { id: true },
      });

      if (existingMembership) {
        return res.status(409).json({
          success: false,
          message: "User is already a member of this organization",
        });
      }

      const membership = await prisma.membership.create({
        data: {
          organizationId: req.organizationId!,
          userId: user.id,
          role: validation.data.role,
          status: "ACTIVE",
        },
        select: memberSelect,
      });

      return res.status(201).json({
        success: true,
        message: "Organization member added successfully",
        data: { member: toMemberResponse(membership) },
      });
    } catch (error) {
      if (isPrismaErrorCode(error, "P2002")) {
        return res.status(409).json({
          success: false,
          message: "User is already a member of this organization",
        });
      }

      console.error("Organization member creation failed:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to add organization member",
      });
    }
  }
);

router.post(
  "/:organizationId/members/create",
  authenticateToken,
  requireOrganizationMembership,
  requireOrganizationAdmin,
  async (req: OrganizationRequest, res) => {
    const validation = createMemberSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid member data",
        errors: validation.error.flatten(),
      });
    }

    try {
      const passwordHash = await bcrypt.hash(validation.data.password, 12);
      const member = await prisma.$transaction(async (transaction) => {
        const user = await transaction.user.create({
          data: {
            name: validation.data.name,
            email: validation.data.email,
            passwordHash,
          },
          select: { id: true },
        });

        return transaction.membership.create({
          data: {
            organizationId: req.organizationId!,
            userId: user.id,
            role: validation.data.role,
            status: "ACTIVE",
          },
          select: memberSelect,
        });
      });

      return res.status(201).json({
        success: true,
        message: "Organization member created successfully",
        data: { member: toMemberResponse(member) },
      });
    } catch (error) {
      if (isPrismaErrorCode(error, "P2002")) {
        return res.status(409).json({
          success: false,
          message: "This email already has an account. Use the existing-user member endpoint instead.",
        });
      }

      console.error("Organization member and user creation failed:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to create organization member",
      });
    }
  }
);

router.get(
  "/:organizationId/members",
  authenticateToken,
  requireOrganizationMembership,
  async (req: OrganizationRequest, res) => {
    const validation = paginationSchema.safeParse(req.query);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid pagination parameters",
        errors: validation.error.flatten(),
      });
    }

    const { page, limit } = validation.data;

    try {
      const [memberships, total] = await Promise.all([
        prisma.membership.findMany({
          where: { organizationId: req.organizationId! },
          orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
          skip: (page - 1) * limit,
          take: limit,
          select: memberSelect,
        }),
        prisma.membership.count({
          where: { organizationId: req.organizationId! },
        }),
      ]);

      return res.status(200).json({
        success: true,
        data: {
          members: memberships.map(toMemberResponse),
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      console.error("Organization member listing failed:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to retrieve organization members",
      });
    }
  }
);

router.patch(
  "/:organizationId/members/:userId/status",
  authenticateToken,
  requireOrganizationMembership,
  requireOrganizationAdmin,
  async (req: OrganizationRequest, res) => {
    const validation = updateStatusSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid membership status",
        errors: validation.error.flatten(),
      });
    }

    const userIdParam = req.params.userId;

    if (typeof userIdParam !== "string" || !userIdParam.trim()) {
      return res.status(400).json({
        success: false,
        message: "A valid user ID is required",
      });
    }

    const userId = userIdParam;

    try {
      const membership = await prisma.$transaction(
        async (transaction) => {
          const currentMembership = await transaction.membership.findFirst({
            where: { organizationId: req.organizationId!, userId },
            select: { userId: true, role: true, status: true },
          });

          if (!currentMembership) {
            return { kind: "not_found" as const };
          }

          if (currentMembership.status === "INVITED") {
            return { kind: "invalid_transition" as const };
          }

          if (
            currentMembership.status === "ACTIVE" &&
            validation.data.status === "SUSPENDED" &&
            currentMembership.role === "ADMIN"
          ) {
            const activeAdminCount = await transaction.membership.count({
              where: {
                organizationId: req.organizationId!,
                role: "ADMIN",
                status: "ACTIVE",
              },
            });

            if (activeAdminCount <= 1) {
              return { kind: "last_admin" as const };
            }
          }

          const updatedMembership = await transaction.membership.update({
            where: {
              organizationId_userId: {
                organizationId: req.organizationId!,
                userId,
              },
            },
            data: { status: validation.data.status },
            select: memberSelect,
          });

          return { kind: "updated" as const, membership: updatedMembership };
        },
        { isolationLevel: "Serializable" }
      );

      if (membership.kind === "not_found") {
        return res.status(404).json({
          success: false,
          message: "Organization member not found",
        });
      }

      if (membership.kind === "invalid_transition") {
        return res.status(409).json({
          success: false,
          message: "Invited memberships cannot be changed through this endpoint",
        });
      }

      if (membership.kind === "last_admin") {
        return res.status(409).json({
          success: false,
          message: "The last active organization admin cannot be suspended",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Organization member status updated successfully",
        data: { member: toMemberResponse(membership.membership) },
      });
    } catch (error) {
      if (isPrismaErrorCode(error, "P2034")) {
        return res.status(409).json({
          success: false,
          message: "Membership changed concurrently. Please retry the request.",
        });
      }

      console.error("Organization member status update failed:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to update organization member status",
      });
    }
  }
);

export default router;
