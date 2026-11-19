import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

export function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  const token = authHeader.substring(7);
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    console.error("JWT_SECRET is not configured");

    return res.status(500).json({
      success: false,
      message: "Authentication service unavailable",
    });
  }

  try {
    const payload = jwt.verify(token, jwtSecret);

    if (
      typeof payload === "string" ||
      typeof payload.sub !== "string"
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
    }

    req.userId = payload.sub;

    return next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token",
    });
  }
}
