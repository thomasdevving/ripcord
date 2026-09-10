# Deploying the Ripcord webapp to Railway

Ripcord runs as one Railway service with one replica, one persistent volume and
one public port. The root `Dockerfile` builds the React app and TypeScript server,
installs the pinned Foundry binaries, and starts everything in one container.

## 1. Create the service

1. In Railway, choose **New Project → Deploy from GitHub repo** and select this repository.
2. Leave **Root Directory** empty so the repository root is the build context.
3. Use the detected root **Dockerfile**. Do not add build or start command overrides.
4. Generate a Railway public domain before configuring auth; the resulting HTTPS
   origin is the value for `RIPCORD_PUBLIC_URL`.

## 2. Add persistent storage

Create a volume and mount it at **`/data`**. The image already sets
`RIPCORD_DATA_DIR=/data` and prepares the mount for its unprivileged Node process.

The volume stores:

- Better Auth accounts, sessions, organizations and memberships in `auth.sqlite`;
- jobs, event logs, live reports and fork artifacts;
- protocol definitions and protocol scan timelines;
- the pinned RPC cache and Mobula sidecars.

Without the volume, accounts and customer data disappear on the next redeploy.
Committed calibration reports remain part of the image.

Use **one replica**. The file-backed queue, SQLite database and process ownership
model are designed for a single application instance. A later multi-replica
version should move both tenant data and jobs to shared database/queue services.

## 3. Set the variables

Add these in the service **Variables** tab:

| Variable | Value | Notes |
| --- | --- | --- |
| `RIPCORD_PUBLIC_URL` | `https://your-service.up.railway.app` | Exact public origin, with no path. |
| `RIPCORD_AUTH_SECRET` | output of `openssl rand -base64 32` | Required in production. Keep it stable across deploys. |
| `RIPCORD_ALLOW_SIGNUP` | `true` initially | Create the first owner, then use `false` if public signup is not wanted. |
| `RPC_URL_1` | your Ethereum Mainnet archive RPC | Required only for new live scans. Wide `eth_getLogs` support improves role coverage. |
| `RIPCORD_ENABLE_LIVE_RUNS` | `false` for setup, then `true` | With `false`, accounts and saved reports work but no new analysis starts. |
| `RIPCORD_MAX_ACTIVE_JOBS` | `1` | Keeps CPU, memory and RPC spend bounded. |
| `RIPCORD_MAX_QUEUED_JOBS` | `3` | Maximum waiting jobs. |
| `RIPCORD_JOB_TIMEOUT_MS` | `600000` | Hard ceiling for one analysis, in milliseconds. |
| `RIPCORD_DEFAULT_BLOCK` | `25800000` | Default historical block used by the current presets. |
| `RIPCORD_INSTANCE_ID` | `railway-web` | Stable identity for this single replica, recommended for fast restart recovery. |
| `MOBULA_API_KEY` | optional | Needed for fresh Mobula asset-context calls, never for the pinned verdict. |

Railway injects `PORT`; leave it unset. `NODE_ENV=production` and
`RIPCORD_DATA_DIR=/data` are already present in the image.

An invalid or missing production auth secret stops startup. A malformed RPC or
boolean also stops startup with the variable name in the log instead of booting
in an ambiguous state.

## 4. First account and private workspace

1. Deploy with `RIPCORD_ENABLE_LIVE_RUNS=false` and `RIPCORD_ALLOW_SIGNUP=true`.
2. Open the Railway domain and choose **Create an account**.
3. Enter the owner's name, email, password and organization name. Ripcord creates
   the account and its first private workspace together.
4. Sign out and sign in once to verify session persistence across requests.
5. If registration should be closed, set `RIPCORD_ALLOW_SIGNUP=false` and redeploy.

Every new protocol, protocol scan, job and live report receives the active
organization ID at creation. All later reads verify the same ownership. A valid
job or report ID from another organization returns 404 and does not reveal that
the object exists. The committed calibration examples remain public reference
artifacts; customer live reports do not.

The current release provides self-registration, organization creation and
organization switching on top of Better Auth's organization membership model.
Email verification, password-reset delivery, invitations and billing need an
email provider and product policy before an external paid launch.

## 5. Adopt data from the pre-account deployment

Legacy live records have no organization owner and therefore become inaccessible
after this update. This is deliberate: silently assigning them to the first user
would be a cross-tenant data leak.

To assign them explicitly:

1. Sign in to the destination organization and click **Copy ID** in the top bar.
2. Set `RIPCORD_LEGACY_ORGANIZATION_ID` to that ID and redeploy once.
3. Check the startup log. It reports exact counts for claimed jobs, reports,
   protocols and protocol scans.
4. Verify the old records in the UI, then remove the variable and redeploy.

The server first verifies that the ID exists in its own auth database. A typo
stops startup before any record is changed. Already-owned records are never
reassigned, so repeating the migration is a no-op.

## 6. Health, sleep and capacity

- Set Railway's health-check path to **`/healthz`**.
- Keep **Serverless/App Sleeping off** for production scans. A sleeping container
  adds a cold start and cannot continue an in-flight analysis.
- Start around **1 vCPU and 2 GB RAM**, run representative scans, and size from
  observed CPU and memory. This is an initial estimate rather than a guaranteed minimum.

`/healthz` deliberately performs no chain call. It confirms that the process and
file store are available. `GET /api/config` separately reports whether the RPC,
live runs and fork sandbox are available.

## 7. RPC and fork requirements

Ripcord pins reads to a historical block. Use an archive endpoint. A provider
that cannot serve history produces `rpc_missing_history`, which the UI labels as
an infrastructure failure rather than a contract finding.

Large `eth_getLogs` ranges materially improve AccessControl reconstruction. A
small range remains supported, but Ripcord may label role coverage partial after
its bounded scan budget is exhausted.

The image contains checksum-pinned `anvil` and `cast` binaries. Anvil binds only
to `127.0.0.1` inside the container and exists for the duration of a fork job; no
RPC or Anvil port is exposed publicly. If Foundry is unavailable, the server
still starts and removes fork modes from the UI.

## 8. Local container smoke test

```sh
docker build -t ripcord-web .
docker run --rm -p 8080:8080 \
  -e RIPCORD_PUBLIC_URL=http://localhost:8080 \
  -e RIPCORD_AUTH_SECRET='replace-with-at-least-32-random-characters' \
  -e RIPCORD_ALLOW_SIGNUP=true \
  -e RIPCORD_ENABLE_LIVE_RUNS=false \
  -v "$PWD/.ripcord-docker-data:/data" \
  ripcord-web

curl -fsS http://localhost:8080/healthz
```

Then configure an archive RPC, set `RIPCORD_ENABLE_LIVE_RUNS=true`, restart the
container and run one direct scan plus one protocol baseline from the browser.
Refresh during a run to verify reconnection, then restart the container to verify
that the account and completed reports remain on the mounted volume.
