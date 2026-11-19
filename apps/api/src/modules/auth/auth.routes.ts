import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../../lib/prisma.js";

const router = Router();

const loginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(128),
});

router.post("/login", async (req, res) => {
  const validation = loginSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Invalid login data",
      errors: validation.error.flatten(),
    });
  }

  const { email, password } = validation.data;

  try {
    const user = await prisma.user.findUnique({
      where: {
        email: email.toLowerCase(),
      },
      include: {
        memberships: {
          where: {
            status: "ACTIVE",
          },
          include: {
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
        message: "Invalid email or password",
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
      throw new Error("JWT_SECRET is not configured");
    }

    const accessToken = jwt.sign(
      { sub: user.id },
      jwtSecret,
      { expiresIn: "15m" }
    );

    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        accessToken,
        tokenType: "Bearer",
        expiresIn: 900,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
        organizations: user.memberships.map((membership) => ({
          id: membership.organization.id,
          name: membership.organization.name,
          slug: membership.organization.slug,
          role: membership.role,
        })),
      },
    });
  } catch (error) {
    console.error("Login failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to process login",
    });
  }
});

export default router;
