"""Whole-country (Brasil) maps.

A state map ships every polygon as GeoJSON plus one value per polygon. For
the whole country that's 468k census tracts and 1.2 GB of geometry -- far
too much -- so the country map works differently:

* Geometry comes as vector tiles (/api/tiles/{z}/{x}/{y}.pbf), built by
  PostGIS (ST_AsMVT) one tile at a time: the browser only loads the tiles in
  view, at a detail level that matches the zoom. Tiles don't depend on the
  indicator, so each is built once and stored in TILES_TABLE.
* Colors come as one precomputed "class string" per indicator: character i
  is the legend item index (0-9) of the i-th tract in the shared id list
  (tract_ids()), or "-" when the tract has no value. ~468 KB, ~8 KB gzipped.
  The browser maps it onto the tiles' features by id (feature-state).
  Strings are stored in CLASSES_TABLE.

Why precompute: `value` is stored grouped by geoobject (all indicators of a
tract together -- what makes state maps fast), so one indicator's rows for
the whole country are spread over the entire 2.5 GB table: reading them
costs ~200 s on this server however it's done. `python -m lib.precompute`
reads the table once and builds every indicator, and builds the tiles of
the zooms used to view the whole country (slow ones: ~5-45 s each).

The caches are tables in the database (shared by every app instance that
uses it); rebuild them after the geometry or the values change.
"""
import hashlib
import math
import threading
from collections import OrderedDict
from functools import lru_cache

import numpy as np
from sqlalchemy import text

from lib import db

# Census tracts. Municipalities also have a county_id (their own id), so
# `county_id is not null` alone isn't enough.
TRACT_TYPE_ID = 9
TRACT_SEP_ID = 10  # strategic sector whose indicators have tract values

CLASSES_TABLE = "webtests_tract_classes"
TILES_TABLE = "webtests_tiles"
BOUNDARY_TILES_TABLE = "webtests_boundary_tiles"

# Boundary lines (their own tiles, drawn over the tract colors).
STATE_TYPE_ID = 4
COUNTY_TYPE_ID = 1
# Municipality lines only from this zoom on: below it they'd be a dense mesh
# (5,570 municipalities, 3.8M points) that's unreadable and heavy.
COUNTY_LINES_MIN_ZOOM = 6

# Vector tiles: MapLibre draws vector tiles 512 px wide; MVT coordinates
# use a 4096 grid, so one grid unit is 1/8 screen pixel.
TILE_EXTENT = 4096
TILE_BUFFER = 64
SCREEN_PX_PER_TILE = 512
# Tracts smaller than this many screen pixels are drawn as one small square
# per SMALL_CELL_PX x SMALL_CELL_PX cell (colored by the biggest tract in the
# cell) instead of as polygons: at country zoom a city's thousands of tracts
# would otherwise be thousands of sub-pixel polygons, or vanish altogether.
SMALL_CELL_PX = 2
MIN_ZOOM = 2  # Brazil fits the map at ~z2.8 on a laptop screen
# The map overzooms MAX_ZOOM tiles beyond it. Those aren't simplified at
# all, only snapped to the tile grid (~0.6 m at z14): simplifying each
# polygon on its own drops different vertices on the two sides of a shared
# border, which shows as slivers between neighbours when zoomed in; snapping
# moves a shared vertex to the same point on both sides.
MAX_ZOOM = 14
PRECOMPUTE_MAX_ZOOM = 9

# Brazil, for the client's fitBounds() and the tile precompute.
BRAZIL_BOUNDS = [[-74.0, -33.8], [-34.7, 5.3]]


@lru_cache(maxsize=1)
def ensure_tables():
    """Create the cache tables if they don't exist yet."""
    schema = db.get_schema()
    with db.get_engine().begin() as conn:
        conn.execute(text(
            f"create table if not exists {schema}.{CLASSES_TABLE} ("
            f"  indicator_id integer primary key,"
            f"  ids_version text not null,"
            f"  classes text not null,"
            f"  built_at timestamptz not null default now())"
        ))
        for table in TILE_TABLES.values():
            conn.execute(text(
                f"create table if not exists {schema}.{table} ("
                f"  z integer not null, x integer not null, y integer not null,"
                f"  data bytea not null,"
                f"  built_at timestamptz not null default now(),"
                f"  primary key (z, x, y))"
            ))
    return True


# --- tract ids -----------------------------------------------------------------

def _tract_ids_sql():
    # Same rows as geoobjecttype_id = 9 (a municipality's county_id is its
    # own id), but answered from geoobject_county_objs_idx (county_id, id)
    # alone, ~1 s; filtering on geoobjecttype_id reads the table, ~2 min cold.
    return (f"select id from {db.get_schema()}.geoobject "
            f"where county_id is not null and county_id <> id order by id")


@lru_cache(maxsize=1)
def _tract_ids():
    ids = db.query_df(_tract_ids_sql())["id"].to_numpy(dtype=np.int64)
    version = hashlib.sha1(ids.tobytes()).hexdigest()[:12]
    return ids, version


def tract_ids():
    """Ids of every census tract, ascending, plus a version hash of the
    list. The class strings are aligned to this list."""
    hits = _tract_ids.cache_info().hits
    ids, version = _tract_ids()
    if _tract_ids.cache_info().hits > hits:
        db.log_sql(f"-- tract id list served from the server's memory; built by:\n{_tract_ids_sql()};")
    return ids, version


def tract_ids_payload():
    """The id list delta-encoded (first id, then differences): consecutive
    ids become runs of 1s, which gzip to ~1 KB."""
    ids, version = tract_ids()
    return {"version": version, "deltas": np.diff(ids, prepend=0).tolist()}


# --- class strings -------------------------------------------------------------

def classify(values, legend):
    """Legend item index of each value, or -1 when it doesn't fall in the
    legend. A value belongs to the item with the highest minvalue <= value,
    so the gaps between ranges (0.19 .. 0.20) and the top bound (1.00, which
    `value < maxvalue` would leave out) go to the item below. Missing values
    get the item without a range ("Dado indisponível"), if there is one."""
    values = np.asarray(values, dtype=float)
    out = np.full(len(values), -1, dtype=np.int16)
    ranged = sorted(
        (item["minvalue"], i) for i, item in enumerate(legend) if item["minvalue"] is not None
    )
    if ranged:
        mins = np.array([m for m, _ in ranged], dtype=float)
        idx = np.array([i for _, i in ranged], dtype=np.int16)
        pos = np.searchsorted(mins, values, side="right") - 1
        ok = ~np.isnan(values) & (pos >= 0)
        out[ok] = idx[pos[ok]]
    no_data = [i for i, item in enumerate(legend) if item["minvalue"] is None]
    if no_data:
        out[np.isnan(values)] = no_data[0]
    return out


def class_string(geoobject_ids, years, values, legend):
    """Class string aligned to tract_ids() (see the module doc)."""
    ids, _ = _tract_ids()
    geoobject_ids = np.asarray(geoobject_ids, dtype=np.int64)
    years = np.asarray(years, dtype=np.int64)
    values = np.array([np.nan if v is None else v for v in values], dtype=float)
    # One value per tract: the latest year (< 2027) wins, as on a state map.
    order = np.lexsort((years, geoobject_ids))
    geoobject_ids, values = geoobject_ids[order], values[order]
    last = np.append(geoobject_ids[1:] != geoobject_ids[:-1], True)
    geoobject_ids, values = geoobject_ids[last], values[last]

    cls = classify(values, legend)
    pos = np.clip(np.searchsorted(ids, geoobject_ids), 0, len(ids) - 1)
    keep = (ids[pos] == geoobject_ids) & (cls >= 0)
    chars = np.full(len(ids), ord("-"), dtype=np.uint8)
    chars[pos[keep]] = ord("0") + cls[keep]
    return chars.tobytes().decode("ascii")


def store_classes(conn, indicator_id, version, classes):
    conn.execute(
        text(
            f"insert into {db.get_schema()}.{CLASSES_TABLE} (indicator_id, ids_version, classes) "
            f"values (:indicator_id, :version, :classes) "
            f"on conflict (indicator_id) do update set ids_version = excluded.ids_version, "
            f"  classes = excluded.classes, built_at = now()"
        ),
        {"indicator_id": indicator_id, "version": version, "classes": classes},
    )


def build_classes(indicator_id):
    """Compute one indicator's class string from `value` and store it.
    Slow when cold (~200 s, see the module doc); precompute.py builds them
    all in one pass instead."""
    _, version = _tract_ids()
    df = db.query_df(
        f"select geoobject_id, year, value from {db.get_schema()}.value "
        f"where indicator_id = :indicator_id and year < 2027",
        {"indicator_id": indicator_id},
    )
    classes = class_string(df["geoobject_id"], df["year"], df["value"], db.fetch_legend(indicator_id))
    with db.get_engine().begin() as conn:
        store_classes(conn, indicator_id, version, classes)
    return classes


# (indicator_id, ids version) -> class string, most recent last.
_classes_mem = OrderedDict()
_classes_lock = threading.Lock()
MAX_CLASSES_IN_MEMORY = 64


def fetch_classes(indicator_id):
    """Return {version, classes} for the indicator: from memory, else from
    CLASSES_TABLE, else built from `value` (slow) and stored."""
    ensure_tables()
    _, version = tract_ids()
    key = (indicator_id, version)
    with _classes_lock:
        classes = _classes_mem.get(key)
    if classes is not None:
        db.log_sql("-- class string served from the server's memory")
    else:
        sql = (
            f"select classes from {db.get_schema()}.{CLASSES_TABLE} "
            f"where indicator_id = :indicator_id and ids_version = :version"
        )
        with db.get_engine().connect() as conn:
            classes = conn.execute(text(sql), {"indicator_id": indicator_id, "version": version}).scalar()
        if classes is None:
            db.log_sql("-- not precomputed yet: built now from the values (slow when cold):")
            classes = build_classes(indicator_id)
        with _classes_lock:
            _classes_mem[key] = classes
            while len(_classes_mem) > MAX_CLASSES_IN_MEMORY:
                _classes_mem.popitem(last=False)
    return {"version": version, "classes": classes}


# --- vector tiles --------------------------------------------------------------

def tile_sql(z, x, y):
    """(sql, params) building one MVT tile (layer "tracts") of all census
    tracts. Feature ids are geoobject ids; there are no other attributes
    (names are looked up on hover), which keeps tiles ~40% smaller."""
    schema = db.get_schema()
    cell = int(SMALL_CELL_PX * TILE_EXTENT / SCREEN_PX_PER_TILE)
    # One screen pixel, in degrees of longitude, at this zoom.
    px_deg = 360.0 / (2 ** z) / SCREEN_PX_PER_TILE
    sql = (
        f"with env as ("
        f"  select ST_TileEnvelope(:z, :x, :y) as e3857,"
        f"         ST_Transform(ST_TileEnvelope(:z, :x, :y, margin => :margin), 4326) as e4326"
        f"), objs as ("
        f"  select g.id, g.geom,"
        f"         greatest(ST_XMax(g.geom) - ST_XMin(g.geom), ST_YMax(g.geom) - ST_YMin(g.geom)) as size"
        f"  from {schema}.geoobject g, env"
        f"  where g.geoobjecttype_id = {TRACT_TYPE_ID} and g.geom && env.e4326"
        f"), polys as ("
        f"  select o.id,"
        f"         ST_AsMVTGeom(ST_Transform(ST_Simplify(o.geom, :tolerance, true), 3857),"
        f"                      env.e3857, :extent, :buffer, true) as geom"
        f"  from objs o cross join env"
        f"  where o.size >= :small"
        f"), points as ("
        f"  select o.id, o.size,"
        f"         ST_AsMVTGeom(ST_Transform(ST_Centroid(ST_Envelope(o.geom)), 3857),"
        f"                      env.e3857, :extent, 0, true) as p"
        f"  from objs o cross join env"
        f"  where o.size < :small"
        f"), squares as ("
        f"  select distinct on (cx, cy) id,"
        f"         ST_MakeEnvelope(cx * :cell, cy * :cell, cx * :cell + :cell, cy * :cell + :cell) as geom"
        f"  from (select id, size, floor(ST_X(p) / :cell)::int as cx, floor(ST_Y(p) / :cell)::int as cy"
        f"        from points where p is not null) s"
        f"  order by cx, cy, size desc"
        f") "
        f"select ST_AsMVT(t, 'tracts', :extent, 'geom', 'id') from ("
        f"  select id, geom from polys where geom is not null"
        f"  union all select id, geom from squares"
        f") t"
    )
    params = {
        "z": z, "x": x, "y": y,
        "margin": TILE_BUFFER / TILE_EXTENT,
        "extent": TILE_EXTENT, "buffer": TILE_BUFFER,
        "tolerance": 0.0 if z >= MAX_ZOOM else px_deg / 2,
        "small": px_deg * SMALL_CELL_PX,
        "cell": cell,
    }
    return sql, params


def boundary_tile_sql(z, x, y):
    """(sql, params) building one MVT tile of boundary lines: layer "states"
    (all zooms) and layer "counties" (municipalities, from
    COUNTY_LINES_MIN_ZOOM on). Lines (ST_Boundary), simplified like the
    tracts, so they line up with the tract polygons."""
    schema = db.get_schema()
    px_deg = 360.0 / (2 ** z) / SCREEN_PX_PER_TILE
    types = [STATE_TYPE_ID] + ([COUNTY_TYPE_ID] if z >= COUNTY_LINES_MIN_ZOOM else [])
    sql = (
        f"with env as ("
        f"  select ST_TileEnvelope(:z, :x, :y) as e3857,"
        f"         ST_Transform(ST_TileEnvelope(:z, :x, :y, margin => :margin), 4326) as e4326"
        f"), lines as ("
        f"  select g.id, g.geoobjecttype_id as type,"
        f"         ST_AsMVTGeom(ST_Transform(ST_Simplify(ST_Boundary(g.geom), :tolerance, true), 3857),"
        f"                      env.e3857, :extent, :buffer, true) as geom"
        f"  from {schema}.geoobject g, env"
        f"  where g.geoobjecttype_id in ({', '.join(map(str, types))}) and g.geom && env.e4326"
        f") "
        # Two MVT layers, concatenated (a tile is a list of layers).
        f"select coalesce((select ST_AsMVT(s, 'states', :extent, 'geom', 'id') from"
        f"  (select id, geom from lines where type = {STATE_TYPE_ID} and geom is not null) s), ''::bytea)"
        f" || coalesce((select ST_AsMVT(c, 'counties', :extent, 'geom', 'id') from"
        f"  (select id, geom from lines where type = {COUNTY_TYPE_ID} and geom is not null) c), ''::bytea)"
    )
    params = {
        "z": z, "x": x, "y": y,
        "margin": TILE_BUFFER / TILE_EXTENT,
        "extent": TILE_EXTENT, "buffer": TILE_BUFFER,
        "tolerance": 0.0 if z >= MAX_ZOOM else px_deg / 2,
    }
    return sql, params


# Tile sets: name -> (query builder, cache table).
TILE_SQL = {"tracts": tile_sql, "boundaries": boundary_tile_sql}
TILE_TABLES = {"tracts": TILES_TABLE, "boundaries": BOUNDARY_TILES_TABLE}


def build_tile(z, x, y, kind="tracts"):
    """Build one tile of the given set with PostGIS and store it."""
    sql, params = TILE_SQL[kind](z, x, y)
    with db.get_engine().begin() as conn:
        data = bytes(conn.execute(text(sql), params).scalar_one() or b"")
        conn.execute(
            text(
                f"insert into {db.get_schema()}.{TILE_TABLES[kind]} (z, x, y, data) "
                f"values (:z, :x, :y, :data) on conflict (z, x, y) do nothing"
            ),
            {"z": z, "x": x, "y": y, "data": data},
        )
    return data


def fetch_tile(z, x, y, kind="tracts"):
    """Return the tile's MVT bytes from its cache table, building it if needed."""
    ensure_tables()
    sql = f"select data from {db.get_schema()}.{TILE_TABLES[kind]} where z = :z and x = :x and y = :y"
    with db.get_engine().connect() as conn:
        data = conn.execute(text(sql), {"z": z, "x": x, "y": y}).scalar()
    return bytes(data) if data is not None else build_tile(z, x, y, kind)


def brazil_tiles(z):
    """(x, y) of the tiles at zoom z that cover Brazil's bounding box."""
    def tx(lon):
        return int((lon + 180.0) / 360.0 * 2 ** z)

    def ty(lat):
        return int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * 2 ** z)

    (w, s), (e, n) = BRAZIL_BOUNDS
    return [(x, y) for x in range(tx(w), tx(e) + 1) for y in range(ty(n), ty(s) + 1)]


def tiles_config():
    """What the client needs to set up the tile source."""
    return {"bounds": BRAZIL_BOUNDS, "minzoom": MIN_ZOOM, "maxzoom": MAX_ZOOM}


def tile_debug_sql():
    """Debug note: the tile query, rendered for one tile over Brazil."""
    sql, params = tile_sql(4, 5, 8)
    return (
        "-- polígonos: vector tiles GET /api/tiles/{z}/{x}/{y}.pbf, one query per tile, "
        f"stored in {db.get_schema()}.{TILES_TABLE} after the first build. Example, tile 4/5/8:\n"
        + db.render_sql(sql, params)
    )
