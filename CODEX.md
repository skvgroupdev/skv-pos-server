# CODEX.md

## Project Notes

This is the backend server for the SKV POS app.

- Main entry: `src/index.ts`
- Runtime: Node.js + Express + TypeScript + MongoDB/Mongoose
- Default dev command: `npm run dev`
- Build command: `npm run build`
- Production command after build: `npm start`

## Local Setup On Mac

Run commands from this folder:

```bash
cd /Users/lailaolabair/my_project/skv-group/skv-pos-server
npm install
npm run dev
```

## Docker

Run Docker commands from this folder so `docker-compose.yml` can read the local `.env` file:

```bash
docker compose up --build
```

Make sure Docker Desktop is running before building or starting the container.

Useful checks:

```bash
curl http://localhost:${PORT:-8000}/health
docker compose ps
docker compose logs -f skv-pos-server
docker compose down
```

The Docker image does not copy `.env` into the image. `docker-compose.yml` injects the folder's `.env` at runtime via `env_file`.
Avoid sharing `docker compose config` output because Docker expands `.env` values in that output.

The server reads `.env` from the project root even when the command is started from a different working directory. Required variables include:

```bash
MONGO_URI
PORT
JWT_SECRET
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION
S3_BUCKET_NAME
```

`uploadService` accepts either `AWS_BUCKET_NAME` or `S3_BUCKET_NAME` for the S3 bucket name.
`API_JSON_LIMIT` is optional and defaults to `1mb`; increase only if tenant logo/QR payloads need it.

## MongoDB Backups To S3

The server can automatically export MongoDB collections as JSON files and upload them to S3 every day at midnight.

Setup:

1. Make sure the AWS credentials can write to the backup bucket.
2. Add these variables to `.env`:

```bash
S3_BACKUP_BUCKET_NAME=skvgroupbucket
S3_BACKUP_PREFIX=backup/pos
BACKUP_ENABLED=true
BACKUP_TIMEZONE=Asia/Vientiane
BACKUP_RETENTION_DAYS=30
```

Backup behavior:

- Scheduled backup runs inside the backend after MongoDB connects.
- Schedule: `0 0 * * *` using `BACKUP_TIMEZONE`, defaulting to `Asia/Vientiane`.
- Each run uploads files under `s3://skvgroupbucket/backup/pos/YYYY-MM-DD/`.
- Each MongoDB collection is uploaded as a separate pretty-printed JSON file named `<collection>.json`.
- Collections named `system.*` are skipped.
- `BACKUP_RETENTION_DAYS=30` deletes backup objects older than 30 days. Set it to `0` to keep all backups.
- If AWS credentials are missing, the server logs a clear error and continues running without the scheduler.

Manual backup test:

```bash
npm run backup:run
```

## What Was Fixed

- `src/index.ts` now imports `src/config/env.ts` before route imports, so environment variables are available before services initialize.
- Removed logging of the full `MONGO_URI` from startup output.
- Fixed TypeScript errors in `src/routes/orders.ts` around `paymentStatus` and `order._id`.
- Fixed invalid `customerId` handling in `src/routes/reports.ts`.
- Fixed S3 bucket env name mismatch in `src/services/uploadService.ts`.
- Added `/health` as an alias of `/healthy` so Docker healthchecks and docs use a valid endpoint.

## Verification

These passed on this Mac:

```bash
npm run build
npm run dev
```

`npm run dev` reached:

```text
Server is running on port 8000
Connected to MongoDB
```

The duplicate `orderId` Mongoose index warning was also cleaned up in `src/models/Order.ts`.

## Notes For Future Codex Work

- The git repository root is `skv-pos-server`, not the parent `skv-group` folder.
- Some files were already modified before this fix: route files and `src/services/ProductService.ts`. Do not revert unrelated existing changes.
- Prefer `npm` because `package-lock.json` is tracked. A `pnpm-lock.yaml` currently exists as an untracked file.
- Keep `.env` out of commits.
