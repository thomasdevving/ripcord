# Deploying the Ripcord webapp to Railway

One service, one replica, the repository root as the build context, the root
`Dockerfile`. These are the concrete manual steps — this repository does not
create the project or deploy on your behalf.

> **Validation status.** The image definition is complete and every assumption it
> makes has been checked against this repository (see §7), but **the Docker build
> itself has not been run** — no container runtime was available on the machine
> where it was written. Treat the first `docker build` as the outstanding step,
> and run it locally before pointing Railway at the repo.

---

## 1. Create the service

1. New Project → **Deploy from GitHub repo** → this repository.
2. Root directory: **the repository root** (leave it empty / `/`).
3. Builder: **Dockerfile**. Railway detects the root `Dockerfile` automatically.
   Do not add a Railway build- or start-command override — the image's own `CMD`
   is the entrypoint, and an override is one more place for the start path to
   drift from the compiled output.

## 2. Volume

Add a volume mounted at **`/data`**.

The image sets `RIPCORD_DATA_DIR=/data`. Its entrypoint prepares the mounted
volume as root, changes ownership only under `/data`, then immediately starts
the service as the unprivileged `node` user (uid 1000). This supports a fresh
Railway volume owned by root. The application still checks writability at boot.
Use one replica; the queue and process-group ownership are local to that service.

Without a volume the app still runs; job records and produced reports simply do
not survive a redeploy. Committed calibration reports are baked into the image
and are always available.

## 3. Environment variables

Set these in the service's **Variables** tab. They are runtime variables —
nothing here is read at build time, and the image builds with no RPC key at all.

| Variable | Value | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | Already set in the image; harmless to repeat. |
| `PORT` | *leave unset* | Railway injects it. The app reads `process.env.PORT` and falls back to 8080. |
| `RPC_URL_1` | your mainnet endpoint | **Must be an archive endpoint.** See §5. |
| `RIPCORD_DATA_DIR` | `/data` | Already set in the image; set explicitly if you move the mount. |
| `RIPCORD_ENABLE_LIVE_RUNS` | `false` for a first deploy, `true` for judging | Default is `false`, so a fresh deploy is preview-safe. |
| `RIPCORD_MAX_ACTIVE_JOBS` | `1` | One analysis at a time keeps results reproducible and bounds RPC spend. |
| `RIPCORD_MAX_QUEUED_JOBS` | `3` | |
| `RIPCORD_JOB_TIMEOUT_MS` | `600000` | An operational **maximum**, not an expected duration. See §6. |
| `RIPCORD_DEFAULT_BLOCK` | `25800000` | The block the Comet preset pins. Visibly historical, and the UI says so. |
| `MOBULA_API_KEY` | *optional* | Only for the separate live-exposure layer. Its absence never blocks a scan or a fork run. |

`RIPCORD_*` are conventions introduced by this webapp. They are not Railway
features and not pre-existing Ripcord CLI flags.

An invalid value fails startup with a message naming the variable and exit code
2 — `RIPCORD_MAX_ACTIVE_JOBS=one` will not silently become zero and give you a
queue that never drains.

## 4. Health check and sleep

- **Health check path:** `/healthz`
- **Serverless / sleep:** **off** for judging. A cold start on the first click is
  a bad demo, and a sleeping service loses in-flight jobs.

`/healthz` deliberately touches no chain. It reports whether *this process* is
healthy. Making it probe mainnet would bill an RPC call per check and would
restart the container whenever the provider hiccupped — the opposite of what a
health check is for. Whether live analysis is currently possible is a separate,
explicit field in `GET /api/config`, and the UI shows it separately.

**A green `/healthz` therefore confirms the app is up, not that every archive
read will succeed.**

## 5. The RPC endpoint

Every Ripcord read is pinned to a historical block, so a non-archive endpoint
fails on essentially everything. The app reports that as
`rpc_missing_history` — an infrastructure gap, never a finding about the
contract.

Two further considerations:

- **`eth_getLogs` range matters for coverage, not just speed.** AccessControl
  role reconstruction chunks to the provider's probed range. On a small-range
  endpoint the scan degrades to a *labelled* partial (`reconstruction.complete =
  false`), which correctly withholds the enumeration witness and keeps verdicts
  cautious. It is honest, but a large-range endpoint gives better coverage.
- **The URL is the key.** It is a runtime server variable only. It is never
  exposed in `/api/config` (which returns the **host** only), never sent to the
  browser, and stripped out of every error by `server/sanitize.ts`.

## 6. Timeouts and the fork sandbox

`RIPCORD_JOB_TIMEOUT_MS` is a ceiling, not a target. Measure the exact demo on
your deployed RPC before choosing it. A warm static-scan cache still needs live
fork reads, while deep-history reconstruction can take minutes. No completion
time is guaranteed by a warm cache.

The image carries a pinned `anvil` and `cast` (Foundry **v1.8.1**, downloaded in
a build stage and verified against a checksum written into the `Dockerfile`).
`foundryup` is deliberately not used: it resolves to whatever is current at build
time, and a fork tool whose version drifts between builds is a reproducibility
hole in exactly the component whose output people are asked to trust.

anvil binds `127.0.0.1` inside the container and is spawned only for the duration
of a job. **Only the web port is published.** There is no public RPC proxy, and
no anvil port is exposed.

If the binaries are missing, the app still boots and says so: fork modes
disappear from `availableModes` and are not offered in the UI. Scans are
unaffected.

## 7. What has been verified, and what has not

Checked against this repository:

- `pnpm install --frozen-lockfile` succeeds — the lockfile matches `package.json`.
- `pnpm build:server && pnpm build:web` produce exactly the three paths the
  `Dockerfile` asserts at build time: `dist-server/server/index.js`,
  `dist-server/server/jobs/worker.js`, `dist-web/index.html`.
- Runtime dependencies after `pnpm prune --prod` are `fastify`,
  `@fastify/static`, `viem`, `zod`, `commander`. React, Vite and React Flow are
  dev dependencies, bundled into `dist-web` at build time and absent from the
  runtime tree.
- The server starts with the exact environment the image sets, serves
  `/healthz`, the frontend and 22 saved reports **with no RPC key configured**,
  and exits cleanly on `SIGTERM`.
- The pinned Foundry release URL and both architecture checksums were fetched
  from the GitHub release and pinned literally.

**Not yet done:** `docker build` and `docker run`. No container runtime was
available. Run both locally before the first Railway deploy:

```sh
docker build -t ripcord-web .
docker run --rm -p 8080:8080 \
  -e RIPCORD_ENABLE_LIVE_RUNS=false \
  -v "$PWD/.ripcord-docker-data:/data" \
  ripcord-web

curl -s localhost:8080/healthz
curl -s localhost:8080/api/config | head -c 400
```

Then, with an archive RPC:

```sh
docker run --rm -p 8080:8080 \
  -e RPC_URL_1="https://…" \
  -e RIPCORD_ENABLE_LIVE_RUNS=true \
  -v "$PWD/.ripcord-docker-data:/data" \
  ripcord-web
```

and run the Comet preset through the UI end to end.

## 8. After deploying

1. Open the service URL. The address field and **Analyze contract** are on the
   first screen.
2. Check the banner: with `RIPCORD_ENABLE_LIVE_RUNS=false` it says plainly why
   Analyze is unavailable, and saved reports still open.
3. Set `RIPCORD_ENABLE_LIVE_RUNS=true`, redeploy, and run the **Compound III
   (Comet)** preset in **Scan + withdrawal test** mode.
4. Refresh mid-run: the page reconnects to the same job and continues. Closing
   the tab does not cancel it.

If a run fails, the UI shows a product-level message plus the job id. That id
correlates with the server log line, which is sanitised the same way — no
provider URL appears in either.
