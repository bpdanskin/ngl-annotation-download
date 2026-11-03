# Neuroglancer Annotations → CSV

A tiny, **fully client-side** web app: paste one or more neuroglancer
state-shortened links and download a CSV of their annotations. No server, no
backend, nothing uploaded — the browser fetches the state JSON directly from the
CAVE state server and does all parsing locally.

- Point / line / ellipsoid / bounding-box annotations
- Local annotation **properties** (enum codes resolved to labels), **descriptions**, linked **segments**
- Automatic **distance** for two-point annotations (lines & bounding boxes) — in native voxel units *and* in nanometers
- **Multiple links at once** (one per line, or upload a `.txt`/`.csv` list) → one combined CSV

## How it works

Each link is resolved to its state-JSON URL and fetched with an
`Authorization: Bearer <token>` header:

```
https://spelunker.cave-explorer.org/#!middleauth+https://global.daf-apis.com/nglstate/api/v1/<id>
                                                  └──────────── fetched directly ────────────┘
```

The CAVE state server (`global.daf-apis.com`) returns permissive CORS headers and
accepts the `Authorization` header cross-origin, which is what makes a serverless,
browser-only app possible.

## Auth token

Reading the state JSON requires a middleauth Bearer token. The app never sends it
anywhere except the state server.

**Local use (your own token):** your token lives in
`~/.cloudvolume/secrets/cave-secret.json` under `middle_auth_token` (the same file
the CAVE Python client uses). Copy that value into the **Auth token** field in the
app and click **Save** — it's kept only in your browser's `localStorage`. If you
don't have one yet, use the "Get a token" link in the app.

**Public deployment (service account):** put a token in [`config.js`](config.js):

```js
window.NGL_CONFIG = { token: "PASTE_SERVICE_ACCOUNT_TOKEN_HERE" };
```

Then users don't need to enter anything. A token typed into the app's field always
takes precedence over `config.js`.

> ⚠️ **`config.js` is served publicly.** Anyone can read that token and act as that
> service account. Only put a token scoped to **public / read-only** permissions
> there, use a **dedicated** service account you can rotate, and monitor its usage.
> (`.gitignore` ignores `config.local.js`, not `config.js` — committing `config.js`
> for deployment is intentional, so double-check what's in it.)

## Run locally

The app must be served over `http://` (not opened as a `file://` path — the state
server rejects the `null` origin that `file://` produces). Any static server works:

- **Windows, no dependencies:** `powershell -ExecutionPolicy Bypass -File serve.ps1` → open <http://localhost:4178/>
- **VS Code:** the "Live Server" extension → *Open with Live Server*
- **Node:** `npx serve` &nbsp;·&nbsp; **Python:** `python -m http.server 4178`

## Deploy to GitHub Pages

1. Put a public-scoped service-account token in `config.js` (see above).
2. Commit everything and push.
3. Repo **Settings → Pages →** deploy from your branch, root (`/`).
4. The app is live at `https://<user>.github.io/<repo>/`.

No build step — it's plain HTML/JS.

## CSV columns

| Column | Meaning |
|---|---|
| `source` | state id (or link) the row came from |
| `layer` | annotation layer name |
| `annotation_id` | neuroglancer annotation id |
| `type` | `point` / `line` / `ellipsoid` / `axis_aligned_bounding_box` |
| `ax,ay,az` | first point (point / pointA / ellipsoid center) |
| `bx,by,bz` | second point (pointB, or ellipsoid radii); blank for single points |
| `distance_native` | Euclidean distance in coordinate units (two-point only) |
| `distance_nm` | distance in nm, using the voxel resolution (two-point only) |
| `resolution_nm_per_voxel` | voxel size of the state's coordinate space, e.g. `4 x 4 x 40` (nm/voxel); constant per state, relates the coordinate columns to nm |
| `description` | annotation description |
| `segments` | linked segment ids, space-separated |
| `prop_*` | one column per local annotation property (enum values shown as labels) |

Columns are the union across all layers and links; cells are blank where a column
doesn't apply.

## Limitations

- Only **inline** (local) annotations are read. Layers whose annotations live in a
  remote precomputed source are skipped (the app reports which ones).
- `distance_nm` needs the state's top-level `dimensions`; without them only
  `distance_native` is filled.
- Coordinates are reported in the state's own coordinate space, as stored.
