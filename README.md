# AdaptaBrasil - Mapa de Indicadores

FastAPI + PostGIS backend that serves AdaptaBrasil indicator values over vector tiles,
rendered as a choropleth map with MapLibre GL in a static frontend.

## Requirements

- Python 3.12+
- Access to a PostgreSQL/PostGIS database with the `adaptabrasil` schema
  (tables `sep`, `indicator`, `state`, `county`, `geoobject`, and the
  `geovalue` materialized view)
- Docker (optional, for containerized runs)

## Setup

1. Clone the repo and create a virtual environment:

   ```bash
   git clone https://github.com/AdaptaBrasil/webtests.git
   cd webtests
   python -m venv .venv
   .venv\Scripts\activate      # Windows
   source .venv/bin/activate   # macOS/Linux
   ```

2. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

3. Copy `.env.example` to `.env` and fill in your database credentials:

   ```bash
   cp .env.example .env
   ```

   | Variable      | Description                          |
   |---------------|---------------------------------------|
   | `DB_HOST`     | Database host                         |
   | `PORT`        | Database port                         |
   | `DB_NAME`     | Database name                         |
   | `DB_USER`     | Database user                         |
   | `DB_PASSWORD` | Database password                     |
   | `DB_SCHEMA`   | Schema holding the application tables |

   `.env` is gitignored — never commit real credentials.

4. Run the app:

   ```bash
   uvicorn main:app --reload
   ```

   Open http://127.0.0.1:8000 in a browser.

## Running with Docker

```bash
docker compose up --build
```

This builds the image, loads environment variables from `.env`, and exposes
the app on http://localhost:8000.

## API

| Endpoint              | Query params                                    | Description                                   |
|------------------------|-------------------------------------------------|------------------------------------------------|
| `GET /api/seps`        | —                                               | List strategic sectors                        |
| `GET /api/indicators`  | `sep_id`                                        | List indicators for a sector                   |
| `GET /api/states`      | —                                               | List states                                    |
| `GET /api/counties`    | `state_id`                                      | List counties for a state                      |
| `GET /api/bounds`     | `state_id`, `county_id` (opt.)                  | Extent of the state or municipality, `[[west, south], [east, north]]` |
| `GET /api/values`     | `indicator_id`, `state_id`, `county_id` (opt.)  | Indicator values and legend colors (`geoobject_id`, `value`, `color`), no geometry |
| `GET /api/legend`     | `indicator_id`                                  | The indicator's color legend (`label`, `color`, `minvalue`, `maxvalue`), in display order |
| `GET /api/brasil/ids`  | —                                              | Ids of all census tracts, ascending, delta-encoded (`version`, `deltas`) |
| `GET /api/brasil/classes` | `indicator_id`                              | Precomputed class string: char *i* = legend item of the *i*-th tract (`-` = no value) |
| `GET /api/brasil/counties` | `indicator_id`                             | Municipality ids, classes and means of the indicator (country map at low zoom) |
| `GET /api/tiles/config` | —                                             | Tile source settings (bounds, min/max zoom, municipality switch zoom, tile set versions) |
| `GET /api/tiles/{z}/{x}/{y}.pbf` | —                                    | Vector tile (layer `tracts`, feature id = geoobject id) of all census tracts |
| `GET /api/boundaries/{z}/{x}/{y}.pbf` | —                                | Vector tile of boundary lines: layers `states` (all zooms) and `counties` (municipalities, zoom 6+) |
| `GET /api/municipalities/{z}/{x}/{y}.pbf` | —                           | Vector tile of municipality polygons (layer `counties`, zooms 2–7) |
| `GET /api/geoobject/{id}` | `indicator_id` (optional)                   | Name and municipality of one geoobject (hover popup); with `indicator_id`, also its `value` (Brasil map popup) |
| `POST /api/warm`      | `state_id`, `county_id` (opt.)                  | Reads the area's values in the background so later `/api/values` calls are fast; returns 202 immediately |

Polygons always come from the vector tiles (see below), for a state, a
municipality or the whole country; only the colors change. For a state or
municipality the map fetches `/api/values` and applies each tract's color and
value as MapLibre feature-state (tracts without state stay invisible), and
zooms to `/api/bounds`. Switching indicators fetches just `/api/values`.

When a state or county is picked, the frontend calls `/api/warm` and prefetches
`/api/bounds`, so the first map for an area doesn't wait on cold disk reads.
Warming the same area again within 15 minutes is a no-op.

Legend classes: a value gets the legend item with the highest `minvalue` <=
value. (Matching `minvalue <= value < maxvalue` would drop values at the top
bound, 1.00, and in the gaps between ranges, e.g. 0.19–0.20.)

## Vector tiles and the whole country ("Brasil")

Polygons are served as **vector tiles** built by PostGIS (`ST_AsMVT`), one per
request, only for the area in view and simplified for the zoom (no
simplification at the top zoom, 14, only snapping to the tile grid, so
neighbouring tracts don't show slivers between them when zoomed in). Tracts
smaller than 2 screen pixels are drawn as one 2 px square per cell, so cities
don't vanish at country zoom. Tiles don't depend on the indicator and are
stored in the table `webtests_tiles` once built. Needs the spatial index
`geoobject_geom_gist` on `geoobject (geom)`.

State and municipality **boundary lines** come from a second, much lighter
tile set (`/api/boundaries/...`, stored in `webtests_boundary_tiles`): state
lines at every zoom, municipality lines from zoom 6, drawn over the colors.

"Brasil" in the Estado list shows all 468k census tracts. Their values are too
slow to read per request, so the country map's colors come from:

- **Class strings**, one per indicator, stored in `webtests_tract_classes`:
  the legend item of every tract (~8 KB gzipped), applied to the tiles'
  features as MapLibre feature-state.
- **Municipality classes**, one set per indicator, stored in
  `webtests_county_classes`. Below zoom 5 (`COUNTY_FILL_MAX_ZOOM`) the country
  map shows the 5,570 municipalities (tiles `/api/municipalities/...`, table
  `webtests_county_tiles`) instead of tracts, each colored by the **mean of its
  tracts' values** (one weight per tract; tracts have similar household counts,
  so this is close to a population-weighted mean). At those zooms most tracts
  are under a pixel: drawn as tracts, cities vanish and large tracts without
  data speckle the map. A box on the map shows the zoom and, on the Brasil
  map, lets you move the switch zoom for testing.

`value` is stored grouped by geoobject, so reading one indicator for the
whole country means reading the whole 2.5 GB table (~200 s). Build every
indicator in one pass, plus the tiles of zooms 2–9, with:

```bash
python -m lib.precompute               # or: classes | tiles | boundaries | counties [max_zoom]
docker compose exec app python -m lib.precompute   # in Docker
```

These tables are shared by every app instance using the database. Rerun the
precompute (after `truncate webtests_tract_classes, webtests_county_classes, webtests_tiles, webtests_boundary_tiles, webtests_county_tiles`,
and bumping `TILE_VERSIONS` in `lib/brasil.py` so browsers drop cached tiles) when the
values or the geometry change. Indicators not precomputed are built on first
request (slow), and tiles not stored are built on demand.

## Project structure

```
main.py           FastAPI app and route definitions
lib/db.py         Database queries (SQLAlchemy + pandas)
lib/brasil.py     Vector tiles; whole-country class strings
lib/precompute.py Builds the country map caches (python -m lib.precompute)
static/           Frontend (MapLibre GL map, vanilla JS)
```
