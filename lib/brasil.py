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
import json
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

# Country map below COUNTY_FILL_MAX_ZOOM: municipalities instead of tracts,
# colored by the mean of their tracts' values (one weight per tract: census
# tracts are drawn with similar household counts, so this is close to a
# population-weighted mean; an area-weighted one lets near-empty rural
# tracts dominate and hides cities -- Sao Paulo's density 0.29 vs 0.72).
# At those zooms most tracts are smaller than a pixel and are drawn as 2px
# squares colored by the biggest tract of each cell, which hides cities
# (dense, tiny tracts) and speckles the map wherever a big tract has no data.
COUNTY_CLASSES_TABLE = "webtests_county_classes"
COUNTY_TILES_TABLE = "webtests_county_tiles"
# Default switch zoom; the map's zoom box lets you try others.
COUNTY_FILL_MAX_ZOOM = 5
# Municipality tiles are built up to this zoom, independently of the
# switch, so a switch tried up to COUNTY_TILES_MAX_ZOOM + 1 still gets
# full-detail borders (beyond, the map overzooms these tiles).
COUNTY_TILES_MAX_ZOOM = 7

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
        # Municipality ids, classes and means of one indicator,
        # as the JSON the client gets (see county_payload()).
        conn.execute(text(
            f"create table if not exists {schema}.{COUNTY_CLASSES_TABLE} ("
            f"  indicator_id integer primary key,"
            f"  ids_version text not null,"
            f"  payload text not null,"
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


def tract_values(geoobject_ids, years, values):
    """One indicator's rows of `value` aligned to tract_ids(): (values,
    has_row). One value per tract -- the latest year (< 2027) wins, as on a
    state map; NaN where the value is null or the tract has no row."""
    ids, _ = _tract_ids()
    geoobject_ids = np.asarray(geoobject_ids, dtype=np.int64)
    years = np.asarray(years, dtype=np.int64)
    values = np.array([np.nan if v is None else v for v in values], dtype=float)
    order = np.lexsort((years, geoobject_ids))
    geoobject_ids, values = geoobject_ids[order], values[order]
    last = np.append(geoobject_ids[1:] != geoobject_ids[:-1], True)
    geoobject_ids, values = geoobject_ids[last], values[last]

    pos = np.clip(np.searchsorted(ids, geoobject_ids), 0, len(ids) - 1)
    keep = ids[pos] == geoobject_ids
    aligned = np.full(len(ids), np.nan)
    has_row = np.zeros(len(ids), dtype=bool)
    aligned[pos[keep]] = values[keep]
    has_row[pos[keep]] = True
    return aligned, has_row


def _class_chars(values, present, legend):
    """Class string: legend index per value, "-" where not present (or the
    value falls outside the legend)."""
    cls = classify(values, legend)
    ok = present & (cls >= 0)
    chars = np.full(len(values), ord("-"), dtype=np.uint8)
    chars[ok] = ord("0") + cls[ok]
    return chars.tobytes().decode("ascii")


def class_string(values, has_row, legend):
    """Class string aligned to tract_ids() (see the module doc), from
    tract_values()."""
    return _class_chars(values, has_row, legend)


# --- municipalities (country map at low zoom) ----------------------------------

def _tract_counties_sql():
    # Same tracts, same order as _tract_ids_sql(), answered from the same
    # index (county_id, id).
    return (f"select id, county_id from {db.get_schema()}.geoobject "
            f"where county_id is not null and county_id <> id order by id")


@lru_cache(maxsize=1)
def _tract_counties():
    """(county ids, county index of each tract), aligned to tract_ids()."""
    df = db.query_df(_tract_counties_sql())
    ids, _ = _tract_ids()
    if not np.array_equal(df["id"].to_numpy(dtype=np.int64), ids):
        raise RuntimeError("tract list changed while building the municipality index; retry")
    county_ids, county_index = np.unique(df["county_id"].to_numpy(dtype=np.int64), return_inverse=True)
    return county_ids, county_index


def county_payload(values, has_row, legend):
    """Per municipality (that has tracts): the mean of its tracts' values
    (one weight per tract; tracts with a null value left out) and that mean's
    legend class. A municipality whose tracts all have null values gets the
    "no data" item; one whose tracts have no rows at all gets "-". JSON text:
    {"ids": [...], "classes": "...", "values": [...]} (classes/values
    aligned to ids)."""
    county_ids, idx = _tract_counties()
    n = len(county_ids)
    ok = has_row & ~np.isnan(values)
    weighted = np.bincount(idx[ok], weights=values[ok], minlength=n)
    total = np.bincount(idx[ok], minlength=n)
    present = np.bincount(idx[has_row], minlength=n) > 0
    mean = np.full(n, np.nan)
    np.divide(weighted, total, out=mean, where=total > 0)
    return json.dumps({
        "ids": county_ids.tolist(),
        "classes": _class_chars(mean, present, legend),
        "values": [None if np.isnan(v) else round(float(v), 4) for v in mean],
    }, separators=(",", ":"))


def indicator_caches(geoobject_ids, years, values, legend):
    """(tract class string, municipality payload) of one indicator, from its
    rows of `value`."""
    aligned, has_row = tract_values(geoobject_ids, years, values)
    return class_string(aligned, has_row, legend), county_payload(aligned, has_row, legend)


def empty_caches(legend):
    """Caches of an indicator without tract values."""
    n = len(_tract_ids()[0])
    return "-" * n, county_payload(np.full(n, np.nan), np.zeros(n, dtype=bool), legend)


def store_classes(conn, indicator_id, version, classes, county):
    """Upsert one indicator's tract class string and municipality payload."""
    schema = db.get_schema()
    for table, column, data in ((CLASSES_TABLE, "classes", classes),
                                (COUNTY_CLASSES_TABLE, "payload", county)):
        conn.execute(
            text(
                f"insert into {schema}.{table} (indicator_id, ids_version, {column}) "
                f"values (:indicator_id, :version, :data) "
                f"on conflict (indicator_id) do update set ids_version = excluded.ids_version, "
                f"  {column} = excluded.{column}, built_at = now()"
            ),
            {"indicator_id": indicator_id, "version": version, "data": data},
        )


def build_classes(indicator_id):
    """Compute one indicator's class string and municipality payload from
    `value` and store them. Slow when cold (~200 s, see the module doc);
    precompute.py builds them all in one pass instead."""
    _, version = _tract_ids()
    df = db.query_df(
        f"select geoobject_id, year, value from {db.get_schema()}.value "
        f"where indicator_id = :indicator_id and year < 2027",
        {"indicator_id": indicator_id},
    )
    classes, county = indicator_caches(
        df["geoobject_id"], df["year"], df["value"], db.fetch_legend(indicator_id))
    with db.get_engine().begin() as conn:
        store_classes(conn, indicator_id, version, classes, county)
    return {"tracts": classes, "counties": county}


# Per-indicator caches: kind -> (table, column). Both are built together.
_CACHES = {"tracts": (CLASSES_TABLE, "classes"), "counties": (COUNTY_CLASSES_TABLE, "payload")}
# (kind, indicator_id, ids version) -> cached text, most recent last.
_classes_mem = OrderedDict()
_classes_lock = threading.Lock()
MAX_CLASSES_IN_MEMORY = 128


def _fetch_cached(kind, indicator_id):
    """One indicator's cached text of the given kind: from memory, else from
    its table, else built from `value` (slow) and stored."""
    ensure_tables()
    _, version = tract_ids()
    key = (kind, indicator_id, version)
    with _classes_lock:
        data = _classes_mem.get(key)
    if data is not None:
        db.log_sql(f"-- {kind} classes served from the server's memory")
        return data, version
    table, column = _CACHES[kind]
    sql = (
        f"select {column} from {db.get_schema()}.{table} "
        f"where indicator_id = :indicator_id and ids_version = :version"
    )
    with db.get_engine().connect() as conn:
        data = conn.execute(text(sql), {"indicator_id": indicator_id, "version": version}).scalar()
    if data is None:
        db.log_sql("-- not precomputed yet: built now from the values (slow when cold):")
        data = build_classes(indicator_id)[kind]
    with _classes_lock:
        _classes_mem[key] = data
        while len(_classes_mem) > MAX_CLASSES_IN_MEMORY:
            _classes_mem.popitem(last=False)
    return data, version


def fetch_classes(indicator_id):
    """Return {version, classes} for the indicator (tract class string)."""
    classes, version = _fetch_cached("tracts", indicator_id)
    return {"version": version, "classes": classes}


def fetch_county_payload(indicator_id):
    """The indicator's municipality payload, as JSON text (see
    county_payload())."""
    return _fetch_cached("counties", indicator_id)[0]


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


def county_tile_sql(z, x, y):
    """(sql, params) building one MVT tile (layer "counties") of municipality
    polygons, for the country map below COUNTY_FILL_MAX_ZOOM. Feature ids
    are the municipalities' geoobject ids (the tracts' county_id)."""
    schema = db.get_schema()
    px_deg = 360.0 / (2 ** z) / SCREEN_PX_PER_TILE
    sql = (
        f"with env as ("
        f"  select ST_TileEnvelope(:z, :x, :y) as e3857,"
        f"         ST_Transform(ST_TileEnvelope(:z, :x, :y, margin => :margin), 4326) as e4326"
        f") "
        f"select ST_AsMVT(t, 'counties', :extent, 'geom', 'id') from ("
        f"  select g.id,"
        f"         ST_AsMVTGeom(ST_Transform(ST_Simplify(g.geom, :tolerance, true), 3857),"
        f"                      env.e3857, :extent, :buffer, true) as geom"
        f"  from {schema}.geoobject g, env"
        f"  where g.geoobjecttype_id = {COUNTY_TYPE_ID} and g.geom && env.e4326"
        f") t where geom is not null"
    )
    params = {
        "z": z, "x": x, "y": y,
        "margin": TILE_BUFFER / TILE_EXTENT,
        "extent": TILE_EXTENT, "buffer": TILE_BUFFER,
        # One tile grid unit (1/8 px), not half a pixel as for tracts: each
        # municipality is simplified on its own, and a coarser tolerance
        # opens gaps between neighbours that speckle the country map.
        "tolerance": px_deg * SCREEN_PX_PER_TILE / TILE_EXTENT,
    }
    return sql, params


# Tile sets: name -> (query builder, cache table).
TILE_SQL = {"tracts": tile_sql, "boundaries": boundary_tile_sql, "counties": county_tile_sql}
TILE_TABLES = {"tracts": TILES_TABLE, "boundaries": BOUNDARY_TILES_TABLE,
               "counties": COUNTY_TILES_TABLE}
# Version of each set, added to its tile URLs (?v=): browsers keep tiles for
# a day (Cache-Control), so bump it after rebuilding a set (truncating its
# table) or they keep showing the old tiles.
TILE_VERSIONS = {"tracts": 1, "boundaries": 1, "counties": 2}
# Highest zoom each set is built for (the map overzooms beyond it).
TILE_MAX_ZOOM = {"tracts": MAX_ZOOM, "boundaries": MAX_ZOOM, "counties": COUNTY_TILES_MAX_ZOOM}


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
    return {
        "bounds": BRAZIL_BOUNDS, "minzoom": MIN_ZOOM, "maxzoom": MAX_ZOOM,
        # Country map: municipalities (their own tiles, up to this zoom - 1)
        # below this zoom, tracts from it on.
        "county_fill_maxzoom": COUNTY_FILL_MAX_ZOOM,
        "county_tiles_maxzoom": COUNTY_TILES_MAX_ZOOM,
        "versions": TILE_VERSIONS,
    }


def tile_debug_sql():
    """Debug note: the tile query, rendered for one tile over Brazil."""
    sql, params = tile_sql(4, 5, 8)
    return (
        "-- polígonos: vector tiles GET /api/tiles/{z}/{x}/{y}.pbf, one query per tile, "
        f"stored in {db.get_schema()}.{TILES_TABLE} after the first build. Example, tile 4/5/8:\n"
        + db.render_sql(sql, params)
    )
