import type { Response, NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import type { AuthenticatedRequest } from "./auth.middleware.js";

export interface OrganizationRequest extends AuthenticatedRequest {
  organizationId?: string;
  organizationRole?: "ADMIN" | "MEMBER";
}

function getSanitizedDatabaseTarget() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return { host: "unknown", database: "unknown" };
  }

  try {
    const databaseUrl = new URL(connectionString);
    return {
      host: databaseUrl.hostname,
      database:
        decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, "")) ||
        "unknown",
    };
  } catch {
    return { host: "unknown", database: "unknown" };
  }
}

export async function requireOrganizationMembership(
  req: OrganizationRequest,
  res: Response,
  next: NextFunction
) {
  const organizationId = req.params.organizationId;

  if (typeof organizationId !== "string" || !organizationId.trim()) {
    return res.status(400).json({
      success: false,
      message: "A valid organization ID is required",
    });
  }

  if (!req.userId) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  try {
    const membership = await prisma.membership.findFirst({
      where: {
        organizationId,
        userId: req.userId,
        status: "ACTIVE",
      },
      select: {
        organizationId: true,
        role: true,
      },
    });

    if (process.env.NODE_ENV === "development") {
      console.info("Organization membership diagnostic:", {
        organizationId,
        userId: req.userId,
        membershipFound: Boolean(membership),
        databaseTarget: getSanitizedDatabaseTarget(),
      });
    }

    if (!membership) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this organization",
      });
    }

    req.organizationId = membership.organizationId;
    req.organizationRole = membership.role;

    return next();
  } catch (error) {
    console.error("Organization authorization failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to verify organization access",
    });
  }
}

export function requireOrganizationAdmin(
  req: OrganizationRequest,
  res: Response,
  next: NextFunction
) {
  if (req.organizationRole !== "ADMIN") {
    return res.status(403).json({
      success: false,
      message: "Organization admin permission required",
    });
  }

  return next();
}
