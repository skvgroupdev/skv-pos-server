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

## What Was Fixed

- `src/index.ts` now imports `src/config/env.ts` before route imports, so environment variables are available before services initialize.
- Removed logging of the full `MONGO_URI` from startup output.
- Fixed TypeScript errors in `src/routes/orders.ts` around `paymentStatus` and `order._id`.
- Fixed invalid `customerId` handling in `src/routes/reports.ts`.
- Fixed S3 bucket env name mismatch in `src/services/uploadService.ts`.

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
