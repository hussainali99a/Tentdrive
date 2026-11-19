# TenantDrive API

## Private file uploads

`POST /api/organization/:organizationId/files/upload` requires a bearer JWT and
an active organization membership. Send multipart form data with a required
`file` part and an optional `folderId` field. Folder IDs are checked against the
selected organization.

Uploads are limited to 25 MiB and support PDF, PNG, JPEG, TXT, CSV, DOCX, and
XLSX files. The API checks the filename extension and file contents, rejects
empty files, and calculates a SHA-256 checksum. Client-supplied owner and
organization IDs are not accepted.

Set `STORAGE_DIR` in the API environment to select the private storage root.
Relative values are resolved from the API working directory. If unset, the API
uses the repository's `storage` directory; files are written under its
`private` subdirectory with cryptographically random names. The storage root
must not be within `apps/web/public`. Upload responses contain file metadata only and do not expose storage
identifiers or filesystem paths.

## Listing and downloading private files

The following endpoints require a bearer JWT and an active membership in the
organization identified in the route:

- `GET /api/organization/:organizationId/files` lists only files owned by the
  authenticated user in that organization.
- `GET /api/organization/:organizationId/files/:fileId` returns safe metadata
  for a file owned by the authenticated user.
- `GET /api/organization/:organizationId/files/:fileId/download` streams a
  file owned by the authenticated user as an attachment.

The listing endpoint accepts `folderId`, `page`, and `limit`. Omit `folderId`
or pass `folderId=null` to list root-level files. A folder ID lists files in
that folder, provided the folder belongs to the selected organization.
Pagination defaults to `page=1` and `limit=20`; page numbers start at 1 and
the maximum `limit` is 100.

Files are private even from other members and organization admins. Requests
for another user's file return the same not-found response as an unknown file;
organization membership alone does not grant access. All file queries are
scoped to the route organization and authenticated owner. Responses never
include storage keys, stored filenames, or physical paths, and no public
download URL is created.

Example PowerShell requests (after obtaining a token from the authentication
endpoint):

```powershell
$api = "http://localhost:3000"
$organizationId = "<organization-id>"
$fileId = "<file-id>"
$token = "<jwt>"
$headers = @{ Authorization = "Bearer $token" }

# List root-level files (page 1, 20 results by default)
Invoke-RestMethod -Method Get `
  -Uri "$api/api/organization/$organizationId/files?folderId=null" `
  -Headers $headers

# List files in a folder, with pagination
$folderId = "<folder-id>"
Invoke-RestMethod -Method Get `
  -Uri "$api/api/organization/$organizationId/files?folderId=$folderId&page=1&limit=50" `
  -Headers $headers

# Read safe metadata
Invoke-RestMethod -Method Get `
  -Uri "$api/api/organization/$organizationId/files/$fileId" `
  -Headers $headers

# Download file bytes to a local destination
Invoke-WebRequest -Method Get `
  -Uri "$api/api/organization/$organizationId/files/$fileId/download" `
  -Headers $headers `
  -OutFile ".\downloaded-file"
```

Run mocked upload tests with `npm test -- files.test.ts` from `apps/api`.
Database integration tests are opt-in with
`TENANTDRIVE_RUN_DB_INTEGRATION=1` and require either an explicitly selected
test database (`TENANTDRIVE_TEST_DATABASE_URL`) or the existing local-database
allow-list guard.
