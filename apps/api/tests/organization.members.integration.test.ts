import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import request from "supertest";

const runIntegrationTests =
  process.env.TENANTDRIVE_RUN_DB_INTEGRATION === "1";
const integrationDescribe = runIntegrationTests ? describe : describe.skip;

const abcOrganizationId = "cmwn49cqq0000hwvf6lk6bu2m";
const testPassword = "StrongPassword2026!";

let app: (typeof import("../src/app.js"))["default"];
let prisma: (typeof import("../src/lib/prisma.js"))["prisma"];

let abcAdminId: string;
let xyzAdminId: string;
let abcOrganizationIdResolved: string;
let xyzOrganizationId: string;
let memberActorId: string;
let existingUserId: string;
let abcOnlyUserId: string;
let xyzOnlyUserId: string;
let lastAdminId: string;
let lastAdminOrganizationId: string;
let existingEmail: string;
let abcOnlyEmail: string;
let xyzOnlyEmail: string;
let newUserEmail: string;
let duplicateCreateEmail: string;

const fixtureEmails: string[] = [];
const fixtureUserIds: string[] = [];
const fixtureOrganizationIds: string[] = [];

function assertNoPasswordHash<T extends { body: unknown }>(response: T): T {
  expect(JSON.stringify(response.body)).not.toContain("passwordHash");
  return response;
}

function authHeader(userId: string) {
  return {
    Authorization: `Bearer ${jwt.sign(
      { sub: userId },
      process.env.JWT_SECRET as string
    )}`,
  };
}

async function createFixtureUser(name: string, key: string) {
  const email = `tenantdrive-it-${fixtureSuffix}-${key}@example.test`;
  fixtureEmails.push(email);

  const user = await prisma.user.create({
    data: {
      name,
      email,
      passwordHash: "integration-fixture-password-hash",
    },
    select: { id: true },
  });
  fixtureUserIds.push(user.id);

  return { id: user.id, email };
}

const fixtureSuffix = randomUUID().replace(/-/g, "");

integrationDescribe("organization member management (database integration)", () => {
  beforeAll(async () => {
    const selectedTestDatabase = process.env.TENANTDRIVE_TEST_DATABASE_URL;

    if (selectedTestDatabase) {
      const selectedDatabase = new URL(selectedTestDatabase);
      const databaseName = selectedDatabase.pathname.replace(/^\//, "");

      if (!/test/i.test(databaseName)) {
        throw new Error(
          "TENANTDRIVE_TEST_DATABASE_URL must point to a database with 'test' in its name"
        );
      }

      process.env.DATABASE_URL = selectedTestDatabase;
    } else {
      const configuredDatabase = process.env.DATABASE_URL;

      if (!configuredDatabase) {
        throw new Error("DATABASE_URL is not configured");
      }

      const selectedDatabase = new URL(configuredDatabase);
      const databaseName = selectedDatabase.pathname.replace(/^\//, "");
      const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(
        selectedDatabase.hostname
      );

      if (
        !isLoopback ||
        databaseName !== "tenantdrive" ||
        process.env.TENANTDRIVE_ALLOW_LOCAL_DEV_DATABASE !== "1"
      ) {
        throw new Error(
          "Without TENANTDRIVE_TEST_DATABASE_URL, explicitly allow only the local tenantdrive database"
        );
      }
    }

    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is not configured");
    }

    const [{ default: loadedApp }, { prisma: loadedPrisma }] = await Promise.all([
      import("../src/app.js"),
      import("../src/lib/prisma.js"),
    ]);

    app = loadedApp;
    prisma = loadedPrisma;

    const [abcAdmin, xyzAdmin] = await Promise.all([
      prisma.user.findUnique({
        where: { email: "admin@abc.com" },
        select: {
          id: true,
          memberships: {
            where: {
              organizationId: abcOrganizationId,
              role: "ADMIN",
              status: "ACTIVE",
            },
            select: { organizationId: true },
          },
        },
      }),
      prisma.user.findUnique({
        where: { email: "admin@xyz.com" },
        select: {
          id: true,
          memberships: {
            where: { role: "ADMIN", status: "ACTIVE" },
            select: {
              organization: { select: { id: true, slug: true } },
            },
          },
        },
      }),
    ]);

    if (!abcAdmin?.memberships.length) {
      throw new Error("The configured ABC admin is not active in the expected organization");
    }

    const xyzMembership = xyzAdmin?.memberships.find(
      ({ organization }) => organization.slug === "xyz-logistics"
    );

    if (!xyzAdmin || !xyzMembership) {
      throw new Error("The active XYZ Logistics admin membership was not found");
    }

    abcAdminId = abcAdmin.id;
    abcOrganizationIdResolved = abcAdmin.memberships[0].organizationId;
    xyzAdminId = xyzAdmin.id;
    xyzOrganizationId = xyzMembership.organization.id;

    const memberActor = await createFixtureUser("Integration Member Actor", "member-actor");
    const existing = await createFixtureUser("Integration Existing User", "existing");
    const abcOnly = await createFixtureUser("Integration ABC Only", "abc-only");
    const xyzOnly = await createFixtureUser("Integration XYZ Only", "xyz-only");

    memberActorId = memberActor.id;
    existingUserId = existing.id;
    existingEmail = existing.email;
    abcOnlyUserId = abcOnly.id;
    abcOnlyEmail = abcOnly.email;
    xyzOnlyUserId = xyzOnly.id;
    xyzOnlyEmail = xyzOnly.email;

    await prisma.membership.create({
      data: {
        organizationId: abcOrganizationIdResolved,
        userId: memberActorId,
        role: "MEMBER",
        status: "ACTIVE",
      },
    });
    await prisma.membership.create({
      data: {
        organizationId: abcOrganizationIdResolved,
        userId: abcOnlyUserId,
        role: "MEMBER",
        status: "ACTIVE",
      },
    });
    await prisma.membership.create({
      data: {
        organizationId: xyzOrganizationId,
        userId: xyzOnlyUserId,
        role: "MEMBER",
        status: "ACTIVE",
      },
    });

    const lastAdmin = await createFixtureUser("Integration Last Admin", "last-admin");
    lastAdminId = lastAdmin.id;
    const lastAdminOrganization = await prisma.organization.create({
      data: {
        name: `TenantDrive Integration ${fixtureSuffix}`,
        slug: `td-it-${fixtureSuffix}`,
      },
      select: { id: true },
    });
    lastAdminOrganizationId = lastAdminOrganization.id;
    fixtureOrganizationIds.push(lastAdminOrganizationId);

    await prisma.membership.create({
      data: {
        organizationId: lastAdminOrganizationId,
        userId: lastAdminId,
        role: "ADMIN",
        status: "ACTIVE",
      },
    });

    newUserEmail = `tenantdrive-it-${fixtureSuffix}-created@example.test`;
    duplicateCreateEmail = existing.email;
    fixtureEmails.push(newUserEmail);
  });

  afterAll(async () => {
    if (!prisma) return;

    try {
      if (fixtureOrganizationIds.length) {
        await prisma.organization.deleteMany({
          where: { id: { in: fixtureOrganizationIds } },
        });
      }

      const remainingFixtures = fixtureEmails.length
        ? await prisma.user.findMany({
            where: { email: { in: fixtureEmails } },
            select: { id: true },
          })
        : [];
      const userIds = [
        ...new Set([
          ...fixtureUserIds,
          ...remainingFixtures.map(({ id }) => id),
        ]),
      ];

      if (userIds.length) {
        await prisma.membership.deleteMany({
          where: { userId: { in: userIds } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: userIds } },
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it("adds the same existing user independently to ABC and XYZ", async () => {
    const abcResponse = assertNoPasswordHash(
      await request(app)
        .post(`/api/organization/${abcOrganizationIdResolved}/members`)
        .set(authHeader(abcAdminId))
        .send({ email: existingEmail, role: "MEMBER" })
    );
    expect(abcResponse.status).toBe(201);
    expect(abcResponse.body.data.member.userId).toBe(existingUserId);

    const xyzResponse = assertNoPasswordHash(
      await request(app)
        .post(`/api/organization/${xyzOrganizationId}/members`)
        .set(authHeader(xyzAdminId))
        .send({ email: existingEmail, role: "MEMBER" })
    );
    expect(xyzResponse.status).toBe(201);
    expect(xyzResponse.body.data.member.userId).toBe(existingUserId);

    const memberships = await prisma.membership.findMany({
      where: {
        userId: existingUserId,
        organizationId: { in: [abcOrganizationIdResolved, xyzOrganizationId] },
      },
      select: { organizationId: true, status: true },
    });
    expect(memberships).toHaveLength(2);
    expect(memberships.map(({ organizationId }) => organizationId).sort()).toEqual(
      [abcOrganizationIdResolved, xyzOrganizationId].sort()
    );
  });

  it("returns 409 for duplicate membership and 404 for an unknown user", async () => {
    const duplicateResponse = assertNoPasswordHash(
      await request(app)
        .post(`/api/organization/${abcOrganizationIdResolved}/members`)
        .set(authHeader(abcAdminId))
        .send({ email: existingEmail, role: "MEMBER" })
    );
    expect(duplicateResponse.status).toBe(409);

    const unknownResponse = assertNoPasswordHash(
      await request(app)
        .post(`/api/organization/${abcOrganizationIdResolved}/members`)
        .set(authHeader(abcAdminId))
        .send({
          email: `unknown-${fixtureSuffix}@example.test`,
          role: "MEMBER",
        })
    );
    expect(unknownResponse.status).toBe(404);
  });

  it("returns 401 without a token and 403 when a MEMBER tries to add a user", async () => {
    const unauthenticatedResponse = assertNoPasswordHash(
      await request(app)
        .post(`/api/organization/${abcOrganizationIdResolved}/members`)
        .send({ email: abcOnlyEmail, role: "MEMBER" })
    );
    expect(unauthenticatedResponse.status).toBe(401);

    const memberResponse = assertNoPasswordHash(
      await request(app)
        .post(`/api/organization/${abcOrganizationIdResolved}/members`)
        .set(authHeader(memberActorId))
        .send({ email: abcOnlyEmail, role: "MEMBER" })
    );
    expect(memberResponse.status).toBe(403);
  });

  it("lists only the requested organization's members", async () => {
    const abcResponse = assertNoPasswordHash(
      await request(app)
        .get(`/api/organization/${abcOrganizationIdResolved}/members?limit=100`)
        .set(authHeader(abcAdminId))
    );
    expect(abcResponse.status).toBe(200);
    const abcMemberIds = abcResponse.body.data.members.map(
      (member: { userId: string }) => member.userId
    );
    expect(abcMemberIds).toContain(abcOnlyUserId);
    expect(abcMemberIds).toContain(existingUserId);
    expect(abcMemberIds).not.toContain(xyzOnlyUserId);

    const xyzResponse = assertNoPasswordHash(
      await request(app)
        .get(`/api/organization/${xyzOrganizationId}/members?limit=100`)
        .set(authHeader(xyzAdminId))
    );
    expect(xyzResponse.status).toBe(200);
    const xyzMemberIds = xyzResponse.body.data.members.map(
      (member: { userId: string }) => member.userId
    );
    expect(xyzMemberIds).toContain(xyzOnlyUserId);
    expect(xyzMemberIds).toContain(existingUserId);
    expect(xyzMemberIds).not.toContain(abcOnlyUserId);
  });

  it("suspends and reactivates access only in the selected organization", async () => {
    const suspendResponse = assertNoPasswordHash(
      await request(app)
        .patch(
          `/api/organization/${abcOrganizationIdResolved}/members/${existingUserId}/status`
        )
        .set(authHeader(abcAdminId))
        .send({ status: "SUSPENDED" })
    );
    expect(suspendResponse.status).toBe(200);

    const suspendedAbcResponse = assertNoPasswordHash(
      await request(app)
        .get(`/api/organization/${abcOrganizationIdResolved}/members`)
        .set(authHeader(existingUserId))
    );
    expect(suspendedAbcResponse.status).toBe(403);

    const activeXyzResponse = assertNoPasswordHash(
      await request(app)
        .get(`/api/organization/${xyzOrganizationId}/members`)
        .set(authHeader(existingUserId))
    );
    expect(activeXyzResponse.status).toBe(200);

    const reactivateResponse = assertNoPasswordHash(
      await request(app)
        .patch(
          `/api/organization/${abcOrganizationIdResolved}/members/${existingUserId}/status`
        )
        .set(authHeader(abcAdminId))
        .send({ status: "ACTIVE" })
    );
    expect(reactivateResponse.status).toBe(200);

    const reactivatedAbcResponse = assertNoPasswordHash(
      await request(app)
        .get(`/api/organization/${abcOrganizationIdResolved}/members`)
        .set(authHeader(existingUserId))
    );
    expect(reactivatedAbcResponse.status).toBe(200);
  });

  it("rejects cross-organization status changes and suspension of the last active ADMIN", async () => {
    const crossOrganizationResponse = assertNoPasswordHash(
      await request(app)
        .patch(
          `/api/organization/${abcOrganizationIdResolved}/members/${xyzOnlyUserId}/status`
        )
        .set(authHeader(abcAdminId))
        .send({ status: "SUSPENDED" })
    );
    expect(crossOrganizationResponse.status).toBe(404);

    const lastAdminResponse = assertNoPasswordHash(
      await request(app)
        .patch(
          `/api/organization/${lastAdminOrganizationId}/members/${lastAdminId}/status`
        )
        .set(authHeader(lastAdminId))
        .send({ status: "SUSPENDED" })
    );
    expect(lastAdminResponse.status).toBe(409);

    const xyzOnlyMembership = await prisma.membership.findUnique({
      where: {
        organizationId_userId: {
          organizationId: xyzOrganizationId,
          userId: xyzOnlyUserId,
        },
      },
      select: { status: true },
    });
    expect(xyzOnlyMembership?.status).toBe("ACTIVE");
  });

  it("creates a user without returning its password hash and rejects duplicate global email", async () => {
    const createResponse = assertNoPasswordHash(
      await request(app)
        .post(`/api/organization/${abcOrganizationIdResolved}/members/create`)
        .set(authHeader(abcAdminId))
        .send({
          name: "Integration Created User",
          email: newUserEmail,
          password: testPassword,
          role: "MEMBER",
        })
    );
    expect(createResponse.status).toBe(201);

    const createdUser = await prisma.user.findUnique({
      where: { email: newUserEmail },
      select: { id: true, passwordHash: true },
    });
    expect(createdUser).not.toBeNull();
    expect(createdUser?.passwordHash).not.toBe(testPassword);
    expect(await bcrypt.compare(testPassword, createdUser!.passwordHash)).toBe(true);

    const duplicateEmailResponse = assertNoPasswordHash(
      await request(app)
        .post(`/api/organization/${abcOrganizationIdResolved}/members/create`)
        .set(authHeader(abcAdminId))
        .send({
          name: "Duplicate Email User",
          email: duplicateCreateEmail,
          password: testPassword,
          role: "MEMBER",
        })
    );
    expect(duplicateEmailResponse.status).toBe(409);
  });
});
