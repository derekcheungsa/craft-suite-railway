# Craft Cloud

Sign-in, a shared file library and version history for Craft Suite, backed by
[Neon](https://neon.com). It is the third Railway service, next to `craft-suite`
(the site) and `craft-relay` (the Claude relay). The site serves it at `/cloud/`
over Railway's private network.

The suite stays local-first: nothing leaves the browser until someone signs in
under **Craft Cloud** in the ⦿ panel and saves a file.

## What it does

- **Accounts:** Neon Auth (email and password). The first account becomes the
  cloud's owner.
- **Library:** files from any app, saved from the panel or by Claude with
  `https://cloud/<name>`. Every app tab on the site sees the same library, on any
  device.
- **Versions:** saving the same name again adds a version; older versions stay
  readable (`GET /cloud/files/<name>?v=1`).
- **Storage:** Postgres, in 2 MB chunks. While the project is unclaimed, Neon
  Object Storage isn't available and the whole project is capped at 100 MB, so
  the cloud stops accepting files at 80 MB.

## Neon, with no Neon account

With no `DATABASE_URL`, the service creates a
[claimable Neon project](https://neon.com/docs/reference/claimable-neon) (Postgres
+ Neon Auth) on first boot and remembers it on its volume (`/data`), so redeploys
keep the same project.

An unclaimed project lasts **72 hours**. To keep it:

1. Sign in as the owner, open the ⦿ panel and click **Keep it: claim in Neon**.
2. In the Neon tab, sign in and accept the transfer.
3. Claiming rotates the database password. In the Neon console, copy the project's
   connection string and set it as `DATABASE_URL` on the `craft-cloud` service.
   Railway redeploys it, and your files and accounts are all still there.

If an unclaimed project expires, the next start creates a new, empty one.

## Variables

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | none | Your own (or the claimed) Neon project. Takes precedence over the saved claimable one. |
| `NEON_AUTH_URL` | from the claimable project | Neon Auth base URL, if you bring your own project. |
| `DATA_DIR` | `/data` | Where the claimable project's details are kept (mount a volume here). |
| `MAX_FILE_MB` | `50` | Largest single file. |
| `UNCLAIMED_LIMIT_MB` | `80` | Storage cap before claim. |
| `STORAGE_LIMIT_MB` | `0` (none) | Storage cap on your own project. |
| `NEON_AUTH_ORIGIN` | `http://localhost:3000` | Origin sent to Neon Auth from this server. Unclaimed projects trust only localhost; after claiming you can add your site's domain in Neon and set it here. The server itself only accepts requests from pages on the same site. |

## API (under `/cloud/`)

| | |
|---|---|
| `GET /status` | Mode (`unclaimed`, `claimed`, `own`), expiry, usage, signed-in user |
| `POST /auth/sign-up`, `/auth/sign-in`, `/auth/sign-out` | `{ email, password }` |
| `GET /files` | Library: newest version of each file |
| `PUT /files/<name>?app=<app>` | Save (raw bytes); adds a version |
| `GET /files/<name>[?v=N]` | Read the newest or a given version |
| `GET /files/<name>/versions` | Version history |
| `DELETE /files/<name>` | Delete every version |
| `POST /claim` | Owner only: start the Neon claim, returns the link |

Requests that change anything must come from a page on the same site.
