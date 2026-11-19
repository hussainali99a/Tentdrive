import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import { prisma } from "../../lib/prisma.js";

const router = Router();

const createOrganizationSchema = z.object({
  organizationName: z.string().trim().min(2).max(100),
  slug: z.string().trim().toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  adminName: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(255),
  password: z.string().min(12).max(128),
});

router.post("/", async (req, res) => {
  const validation = createOrganizationSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Invalid registration data",
      errors: validation.error.flatten(),
    });
  }

  const { organizationName, slug, adminName, email, password } =
    validation.data;

  try {
    const passwordHash = await bcrypt.hash(password, 12);

    const organization = await prisma.organization.create({
      data: {
        name: organizationName,
        slug,
        memberships: {
          create: {
            role: "ADMIN",
            status: "ACTIVE",
            user: {
              create: {
                name: adminName,
                email: email.toLowerCase(),
                passwordHash,
              },
            },
          },
        },
      },
      include: {
        memberships: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    return res.status(201).json({
      success: true,
      message: "Organization created successfully",
      data: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        admin: organization.memberships[0]?.user,
        role: organization.memberships[0]?.role,
      },
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return res.status(409).json({
        success: false,
        message: "Organization slug or user email already exists",
      });
    }

    console.error("Organization creation failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to create organization",
    });
  }
});

export default router;
