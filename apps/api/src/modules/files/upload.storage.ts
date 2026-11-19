import { randomBytes } from "node:crypto";
import type { ReadStream } from "node:fs";
import {
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import path, { dirname, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { StorageEngine } from "multer";

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);
const publicDirectory = resolve(workspaceRoot, "apps", "web", "public");
const defaultStorageRoot = resolve(workspaceRoot, "storage");
const storageFilePattern = /^[a-f0-9]{64}$/;

export class UploadStorageError extends Error {}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const pathFromDirectory = relative(directory, candidate);
  return (
    pathFromDirectory === "" ||
    (pathFromDirectory !== ".." &&
      !pathFromDirectory.startsWith(`..${sep}`) &&
      !path.isAbsolute(pathFromDirectory))
  );
}

async function getPrivateStorageDirectory(): Promise<string> {
  const configuredDirectory = process.env.STORAGE_DIR?.trim();
  const storageRoot = resolve(process.cwd(), configuredDirectory || defaultStorageRoot);
  const privateDirectory = resolve(storageRoot, "private");

  if (isWithinDirectory(publicDirectory, privateDirectory)) {
    throw new Error("Private storage must be outside public web assets");
  }

  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });

  const resolvedPrivateDirectory = await realpath(privateDirectory);
  let resolvedPublicDirectory: string | null = null;
  try {
    resolvedPublicDirectory = await realpath(publicDirectory);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  if (
    resolvedPublicDirectory &&
    isWithinDirectory(resolvedPublicDirectory, resolvedPrivateDirectory)
  ) {
    throw new Error("Private storage must be outside public web assets");
  }

  return resolvedPrivateDirectory;
}

function getStoredFilePath(directory: string, filename: string): string {
  if (!storageFilePattern.test(filename)) {
    throw new Error("Invalid private storage identifier");
  }
  return resolve(directory, filename);
}

export class UnsafePrivateStoragePathError extends Error {}

export async function openStoredUpload(
  storageKey: string,
  storedName: string,
): Promise<ReadStream> {
  if (
    !storageFilePattern.test(storageKey) ||
    !storageFilePattern.test(storedName) ||
    storageKey !== storedName
  ) {
    throw new UnsafePrivateStoragePathError(
      "Private storage metadata is invalid",
    );
  }

  const directory = await getPrivateStorageDirectory();
  const filePath = getStoredFilePath(directory, storageKey);
  if (!isWithinDirectory(directory, filePath)) {
    throw new UnsafePrivateStoragePathError(
      "Private storage path is outside the configured directory",
    );
  }

  const resolvedFilePath = await realpath(filePath);
  if (!isWithinDirectory(directory, resolvedFilePath)) {
    throw new UnsafePrivateStoragePathError(
      "Private storage path is outside the configured directory",
    );
  }

  const fileHandle = await open(resolvedFilePath, "r");
  try {
    const fileStats = await fileHandle.stat();
    if (!fileStats.isFile()) {
      throw new UnsafePrivateStoragePathError(
        "Private storage target is not a regular file",
      );
    }
    return fileHandle.createReadStream();
  } catch (error) {
    await fileHandle.close();
    throw error;
  }
}

export async function removeStoredUpload(filename: string): Promise<void> {
  const directory = await getPrivateStorageDirectory();
  const filePath = getStoredFilePath(directory, filename);
  try {
    await unlink(filePath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export const privateUploadStorage: StorageEngine = {
  _handleFile(_req, file, callback) {
    void (async () => {
      const directory = await getPrivateStorageDirectory();
      let filename: string | undefined;
      let filePath: string | undefined;
      let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        filename = randomBytes(32).toString("hex");
        filePath = getStoredFilePath(directory, filename);
        try {
          fileHandle = await open(filePath, "wx", 0o600);
          break;
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "EEXIST"
          ) {
            continue;
          }
          throw error;
        }
      }

      if (!fileHandle || !filename || !filePath) {
        throw new Error("Unable to allocate a unique private storage name");
      }

      try {
        const output = fileHandle.createWriteStream();
        await pipeline(file.stream, output);
        callback(null, {
          destination: directory,
          filename,
          path: filePath,
          size: output.bytesWritten,
        });
      } catch (error) {
        await fileHandle.close().catch(() => undefined);
        await unlink(filePath).catch(() => undefined);
        throw new UploadStorageError(
          error instanceof Error ? error.message : "Upload storage failed",
        );
      }
    })().catch((error: unknown) => {
      callback(
        error instanceof UploadStorageError
          ? error
          : new UploadStorageError("Upload storage failed"),
      );
    });
  },

  _removeFile(_req, file, callback) {
    void removeStoredUpload(file.filename)
      .then(() => callback(null))
      .catch((error: unknown) =>
        callback(error instanceof Error ? error : new Error("Upload cleanup failed")),
      );
  },
};
