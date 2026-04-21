## Road Safety Backend (Node + TypeScript)

This backend builds a **live** Austin dataset (no mock/demo fallback) and serves GeoJSON for your Mapbox UI.

### Scoring (trained model)

After segments load, the backend fits a **ridge regression** on **`log1p(accident_count)`** using:

- `log1p(traffic_volume)`, `speed_limit`, `num_lanes`, `urban_density` (z-scored on the training table)
- `crosswalk_present`, `is_intersection` (0/1)
- Top **12** `road_type` values (one-hot; all other types share the implicit baseline)

Predicted crash count is **`expm1(linear_predictor)`**, clipped at 0. **`safety_score`** is still `exp(-0.08 * predicted_count)` on \([0,1]\).

Training runs on **any non-empty** segment table (including small samples). If the normal equations stay singular, the backend retries with **stronger ridge** penalties; if those still fail, it uses an **intercept-only** model (constant mean \(\log(1+\text{crashes})\) in log space) so responses always use `explanation.model: "ridge_log1p"` with no separate heuristic scorer.

### What it pulls (live)

1. **Crash points (real)** — City of Austin Open Data (Socrata): `y2wy-tgr5`  
   Filtered to your bounding box using `within_box(...)`.

2. **Road geometry (real)** — OpenStreetMap via the **Overpass API**  
   `highway=*` ways inside the same bounding box.

3. **Intersections (Mapbox-confirmed)** — OSM-derived junction candidates (shared vertices / degree heuristics), then confirmed using **Mapbox Tilequery** on `mapbox.mapbox-streets-v8` (`layers=road`).  
   A candidate becomes an intersection if Tilequery returns **2+ road features** near the point.

### Targets / features

- **`accident_count`**: count of distinct crash IDs near the segment line (~22m) or intersection point (~42m).
- **`traffic_volume`**: **not TxDOT yet** — a deterministic proxy derived from OSM `highway` class (until you link TxDOT AADT tables).
- **`speed_limit` / `num_lanes` / `crosswalk_present`**: `1` if the road way has positive OSM `crossing=*` (and related) tags **or** if any OSM node `highway=crossing` (excluding `crossing=no`) lies within **~22 m** of the segment line / intersection point (spatial join on the same Overpass bbox).
- **`urban_density`**: normalized from local crash intensity along the segment (a density proxy, not Census).

### Required configuration

Create `backend/.env` or `backend/.env.local` (loaded automatically via `dotenv`):

- **`MAPBOX_ACCESS_TOKEN`**: required for Tilequery intersection confirmation (your usual `pk.*` public token is fine in dev).

If you already have `VITE_MAPBOX_TOKEN` in the frontend env, you can paste the same value into `backend/.env` as `MAPBOX_ACCESS_TOKEN=...` — the backend does not read `frontend/.env.local`.

Optional:

- **`AUSTIN_BBOX`**: `west,south,east,north` (example: `-97.78,30.24,-97.68,30.32`)
- **`CACHE_MAX_AGE_HOURS`**: default `6` (uses `data/cache/segments.json` when fresh)
- **`MAX_CRASH_ROWS`**, **`MAX_WAYS_TOPO`**, **`MAX_WAYS_RENDER`**, **`MAX_IX_CANDIDATES`**, **`MAX_INTERSECTIONS`**

Offline override (not “live”):

- **`SEGMENTS_CSV_PATH`**: if set, the server will **only** load that CSV and will not fetch external data.

### Run

```bash
cd backend
npm install
set MAPBOX_ACCESS_TOKEN=pk....   # PowerShell: $env:MAPBOX_ACCESS_TOKEN="pk...."
npm run dev
```

### Endpoints

- `GET /health`
- `GET /segments` — `LineString` road segments only
- `GET /intersections?max_safety=0.6` — `Point` intersections only

### Notes

- First startup can take a while (Overpass + Socrata pagination + many Tilequery calls). Subsequent runs use the cache until it expires.
- If you need **strict TxDOT traffic volumes**, the next step is joining a Travis County / Austin AADT dataset to OSM edge IDs or geometry.
