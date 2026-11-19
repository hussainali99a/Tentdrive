-- CreateTable
CREATE TABLE "Folder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "File" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "folderId" TEXT,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "checksum" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "File_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Folder_organizationId_ownerId_idx" ON "Folder"("organizationId", "ownerId");

-- CreateIndex
CREATE INDEX "Folder_organizationId_parentId_name_idx" ON "Folder"("organizationId", "parentId", "name");

-- CreateIndex
CREATE INDEX "Folder_ownerId_idx" ON "Folder"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Folder_organizationId_id_key" ON "Folder"("organizationId", "id");

-- CreateIndex
CREATE INDEX "File_organizationId_ownerId_idx" ON "File"("organizationId", "ownerId");

-- CreateIndex
CREATE INDEX "File_organizationId_folderId_idx" ON "File"("organizationId", "folderId");

-- CreateIndex
CREATE INDEX "File_organizationId_createdAt_idx" ON "File"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "File_ownerId_idx" ON "File"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "File_organizationId_storageKey_key" ON "File"("organizationId", "storageKey");

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_organizationId_parentId_fkey" FOREIGN KEY ("organizationId", "parentId") REFERENCES "Folder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_organizationId_folderId_fkey" FOREIGN KEY ("organizationId", "folderId") REFERENCES "Folder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
