import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { TextDecoder } from "node:util";
import * as yauzl from "yauzl";

export const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;

const fileTypes = {
  ".pdf": {
    mimeType: "application/pdf",
  },
  ".png": {
    mimeType: "image/png",
  },
  ".jpg": {
    mimeType: "image/jpeg",
  },
  ".jpeg": {
    mimeType: "image/jpeg",
  },
  ".txt": {
    mimeType: "text/plain",
  },
  ".csv": {
    mimeType: "text/csv",
  },
  ".docx": {
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  ".xlsx": {
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
} as const;

export class UploadValidationError extends Error {}

export function getAllowedFileType(extension: string) {
  return fileTypes[extension.toLowerCase() as keyof typeof fileTypes];
}

async function containsOfficeEntries(
  filePath: string,
  expectedDocument: "word/document.xml" | "xl/workbook.xml",
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      { lazyEntries: true, autoClose: true },
      (error, zipFile) => {
        if (error || !zipFile) {
          reject(new UploadValidationError("The uploaded Office document is invalid"));
          return;
        }

        let foundContentTypes = false;
        let foundDocument = false;
        let settled = false;
        const finish = (result: boolean) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };

        zipFile.on("entry", (entry) => {
          if (entry.fileName === "[Content_Types].xml") foundContentTypes = true;
          if (entry.fileName === expectedDocument) foundDocument = true;

          if (foundContentTypes && foundDocument) {
            finish(true);
            zipFile.close();
            return;
          }
          zipFile.readEntry();
        });
        zipFile.on("end", () => finish(foundContentTypes && foundDocument));
        zipFile.on("error", () =>
          reject(new UploadValidationError("The uploaded Office document is invalid")),
        );
        zipFile.readEntry();
      },
    );
  });
}

export async function inspectUploadedFile(
  filePath: string,
  extension: string,
): Promise<{ mimeType: string; checksum: string; size: number }> {
  const type = getAllowedFileType(extension);
  if (!type) {
    throw new UploadValidationError("This file extension is not supported");
  }

  const checksum = createHash("sha256");
  const decoder =
    extension === ".txt" || extension === ".csv"
      ? new TextDecoder("utf-8", { fatal: true })
      : null;
  const prefixParts: Buffer[] = [];
  let prefixSize = 0;
  let size = 0;

  try {
    for await (const chunk of createReadStream(filePath)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      checksum.update(bytes);

      if (prefixSize < 1024) {
        const prefixChunk = bytes.subarray(0, 1024 - prefixSize);
        prefixParts.push(prefixChunk);
        prefixSize += prefixChunk.length;
      }

      if (decoder) {
        if (bytes.includes(0)) {
          throw new UploadValidationError("Text files must not contain binary data");
        }
        decoder.decode(bytes, { stream: true });
      }
    }
    if (decoder) decoder.decode();
  } catch (error) {
    if (error instanceof UploadValidationError) throw error;
    if (decoder) {
      throw new UploadValidationError("Text files must contain valid UTF-8 text");
    }
    throw error;
  }

  if (size === 0) {
    throw new UploadValidationError("Empty files are not allowed");
  }

  const prefix = Buffer.concat(prefixParts);
  let contentMatches = false;

  switch (extension) {
    case ".pdf":
      contentMatches =
        prefix.subarray(0, 1024).toString("ascii").indexOf("%PDF-") >= 0;
      break;
    case ".png":
      contentMatches = prefix
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      break;
    case ".jpg":
    case ".jpeg":
      contentMatches =
        prefix.length >= 3 &&
        prefix[0] === 0xff &&
        prefix[1] === 0xd8 &&
        prefix[2] === 0xff;
      break;
    case ".txt":
    case ".csv":
      contentMatches = true;
      break;
    case ".docx":
      contentMatches =
        prefix.length >= 4 &&
        prefix[0] === 0x50 &&
        prefix[1] === 0x4b &&
        prefix[2] === 0x03 &&
        prefix[3] === 0x04 &&
        (await containsOfficeEntries(filePath, "word/document.xml"));
      break;
    case ".xlsx":
      contentMatches =
        prefix.length >= 4 &&
        prefix[0] === 0x50 &&
        prefix[1] === 0x4b &&
        prefix[2] === 0x03 &&
        prefix[3] === 0x04 &&
        (await containsOfficeEntries(filePath, "xl/workbook.xml"));
      break;
  }

  if (!contentMatches) {
    throw new UploadValidationError(
      "The file extension does not match the uploaded file contents",
    );
  }

  return { mimeType: type.mimeType, checksum: checksum.digest("hex"), size };
}
