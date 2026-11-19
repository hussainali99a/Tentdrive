ALTER TABLE "Folder"
ADD CONSTRAINT "Folder_parent_not_self_check"
CHECK ("parentId" IS NULL OR "parentId" <> "id");
