import "dotenv/config";
import { prisma } from "../../lib/prisma.js";

async function main() {
  const organizations = await prisma.organization.findMany();
  const users = await prisma.user.findMany();

  console.log("Database connection successful");
  console.log("Organizations:", organizations.length);
  console.log("Users:", users.length);
}

main()
  .catch((error) => {
    console.error("Database test failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
