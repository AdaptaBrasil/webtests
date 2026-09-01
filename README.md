# AdaptaBrasil - Mapa de Indicadores

FastAPI + PostGIS backend that serves AdaptaBrasil indicator values as GeoJSON,
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
| `GET /api/geovalues`   | `indicator_id`, `state_id`, `county_id` (opt.)  | GeoJSON `FeatureCollection` of indicator values |

For `/api/geovalues` without `county_id` (state-wide view), geometry is
simplified server-side (`ST_SimplifyPreserveTopology`) since state views can
include tens of thousands of sub-county polygons; county-scoped requests are
served at full resolution.

## Project structure

```
main.py           FastAPI app and route definitions
lib/db.py         Database queries (SQLAlchemy + pandas)
static/           Frontend (MapLibre GL map, vanilla JS)
```
