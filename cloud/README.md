# Craft Cloud

Sign-in, a shared file library and version history for Craft Suite, backed by
[Neon](https://neon.com). It is the third Railway service, next to `craft-suite`
(the site) and `craft-relay` (the Claude relay). The site serves it at `/cloud/`
over Railway's private network.

The suite stays local-first: nothing leaves the browser until someone signs in
under **Craft Cloud** in the ⦿ panel and saves a file.

## What it does

- **Private to one owner:** Neon Auth (email and password). The first account
  created on a new copy owns the cloud; after that, sign-ups close and only the
  owner can sign in. Anyone else visiting the site keeps using the apps with
  local saving, and the panel offers them a private copy of their own
  (`TEMPLATE_URL`, the Railway template).
- **Library:** the open document, saved from the ⦿ panel with one click, or by
  Claude with `https://cloud/<name>`. WordCraft, GridCraft, DeckCraft, FigCraft,
  CADCraft and PdfCraft save in their own format (.docx, .xlsx, .deckcraft,
  .figcraft, .dxf, .pdf) under the document's name; PhotoCraft saves a full-size
  PNG of the image. The app's own save runs, and the file goes to the cloud
  instead of the Downloads folder. Every app tab on the site sees the same library, on any
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
3. Claiming gives the database a new password, so the panel asks for it once: open
   the project in Neon (the panel links to it), click **Connect**, copy the
   connection string and paste it into the panel. The service checks that the
   database holds this cloud and that you are its owner, reconnects and remembers
   it on its volume. No Railway settings, no redeploy; files and accounts are all
   still there.

(Setting `DATABASE_URL` on the service still works too, and takes precedence.)

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
| `TEMPLATE_URL` | `https://railway.com/deploy/craft-suite` | Where the panel sends visitors to get their own private copy. |
| `NEON_AUTH_ORIGIN` | `http://localhost:3000` | Origin sent to Neon Auth from this server. Unclaimed projects trust only localhost; after claiming you can add your site's domain in Neon and set it here. The server itself only accepts requests from pages on the same site. |

## API (under `/cloud/`)

| | |
|---|---|
| `GET /status` | Mode (`unclaimed`, `claimed`, `own`), expiry, usage, signed-in user |
| `POST /auth/sign-up`, `/auth/sign-in`, `/auth/sign-out` | `{ email, password }`; sign-up only while the cloud has no owner |
| `GET /files` | Library: newest version of each file |
| `PUT /files/<name>?app=<app>` | Save (raw bytes); adds a version |
| `GET /files/<name>[?v=N]` | Read the newest or a given version |
| `GET /files/<name>/versions` | Version history |
| `DELETE /files/<name>` | Delete every version |
| `POST /claim` | Owner only: start the Neon claim, returns the link |
| `POST /connect` | Owner only, after a claim: `{ databaseUrl }`, the claimed project's new connection string |

Requests that change anything must come from a page on the same site.
