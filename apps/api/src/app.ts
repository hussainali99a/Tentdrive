import express from "express";
import cors from "cors";
import helmet from "helmet";
import { prisma } from "./lib/prisma.js";
import organizationRoutes from "./modules/organizations/organization.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import authMeRoutes from "./modules/auth/auth.me.routes.js";
import protectedOrganizationRoutes from "./modules/organizations/organization.protected.routes.js";
import organizationMemberRoutes from "./modules/organizations/organization.members.routes.js";
import folderRoutes from "./modules/folders/folder.routes.js";
import fileRoutes from "./modules/files/file.routes.js";
const app = express();

app.use(helmet());

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    credentials: true,
  }),
);

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    service: "tenantdrive-api",
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health/db", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.status(200).json({
      success: true,
      database: "connected",
      service: "tenantdrive-api",
    });
  } catch (error) {
    console.error("Database health check failed:", error);

    res.status(503).json({
      success: false,
      database: "disconnected",
    });
  }
});
app.use("/api/organizations", organizationRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/auth", authMeRoutes);
app.use("/api/organization", protectedOrganizationRoutes);
app.use("/api/organization", organizationMemberRoutes);
app.use("/api/organization", folderRoutes);
app.use("/api/organization", fileRoutes);
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

export default app;
