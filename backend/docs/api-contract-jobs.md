# Jobs API Contract (Production Baseline)

## 1) `POST /jobs/nearby`
- Auth: Bearer token (worker)
- Body:
  - `lat` number (required)
  - `lon` number (required)
  - `workerType` string (optional)
- Behavior:
  - Returns only active/offerable jobs within 10km.
  - Excludes `cancelled`, `expired`, and `isCancelled === true`.
  - If worker has unpaid assigned job (single/bulk), returns empty array.

## 2) `GET /jobs`
- Auth: Bearer token (contractor)
- Behavior:
  - Returns contractor jobs using `contractorPhone` as source of truth.
  - Backward-compatible fallback to `contractorName`.

## 3) `POST /jobs/attendance/:jobId`
- Auth: Bearer token (contractor)
- Body:
  - `status`: `"Present"` | `"Absent"` (required)
  - `workerPhone` string (required for bulk jobs; optional for single jobs)
- Behavior:
  - Single job: updates job-level attendance fields.
  - Bulk job: updates matching worker entry under `acceptedWorkers[]`.

## 4) `POST /jobs/pay/:jobId`
- Auth: Bearer token (contractor)
- Headers:
  - `X-Idempotency-Key` string (recommended)
- Body:
  - `mode` string (`"Cash"` | `"Online"`)
  - `workerPhone` string (required for bulk jobs; optional for single jobs)
  - `idempotencyKey` string (optional body fallback)
- Behavior:
  - Enforces server lock for concurrent duplicate pay attempts.
  - Uses idempotency cache for repeated requests with same key.
  - Single job: marks whole job paid.
  - Bulk job: pays one worker entry; job marks paid/completed when all accepted workers are paid.

## 5) `POST /jobs/rate/:jobId`
- Auth: Bearer token (contractor)
- Body:
  - `stars` number (1..5)
  - `feedback` string (optional)
  - `workerPhone` string (required for bulk ratings; optional for single)
- Behavior:
  - Single job: stores rating in `job.rating`.
  - Bulk job: stores rating in matched `acceptedWorkers[n].rating`.
  - Recomputes worker average rating from both single and bulk rating records.

## 6) `POST /jobs/cancel/:jobId`
- Auth: Bearer token
- Behavior:
  - Emits `jobCancelled` using targeted recipients (contractor + affected workers).
  - Avoids global broadcast by default.

## Socket Events
- `jobUpdated`: targeted update dispatch.
- `jobCancelled`: targeted cancellation/expiry dispatch to affected users.

## Notes
- Contractor identity should use `contractorPhone` whenever available.
- For horizontally scaled deployments, replace in-memory idempotency/locks with Redis.
