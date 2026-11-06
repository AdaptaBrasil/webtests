import contextvars
import os
import threading
import time
from contextlib import contextmanager
from functools import lru_cache

import pandas as pd
from sqlalchemy import create_engine, event, text
# Registers PostGIS geometry <-> SQLAlchemy type adapters (PostGIS access via
# SQLAlchemy is required by the project even though these routines only read
# already-serialized GeoJSON columns).
import geoalchemy2  # noqa: F401


def _require(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


@lru_cache(maxsize=1)
def get_engine(echo=False):
    """Build a SQLAlchemy engine from the connection environment variables."""
    host = _require("DB_HOST")
    port = os.environ.get("PORT", "5432")
    dbname = _require("DB_NAME")
    user = _require("DB_USER")
    password = _require("DB_PASSWORD")

    url = f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{dbname}"
    # The DB role's default search_path doesn't include `public`, where the
    # PostGIS functions (ST_AsGeoJSON, ST_SimplifyPreserveTopology, ...) live.
    search_path = f"{get_schema()},public"
    engine = create_engine(
        url, echo=echo, connect_args={"options": f"-csearch_path={search_path}"}
    )
    event.listen(engine, "before_cursor_execute", _record_sql)
    return engine


@lru_cache(maxsize=1)
def get_schema():
    """Return the Postgres schema that holds the application tables."""
    return _require("DB_SCHEMA")


# --- Debug SQL capture -------------------------------------------------------
# While capture_sql() is active (one request with debug on), every statement
# sent to Postgres is recorded with its parameters merged in by psycopg2's
# mogrify -- i.e. exactly the SQL the server runs, ready to paste into a SQL
# client. The log lives in a context variable, so concurrent requests don't
# mix their statements.
_sql_log = contextvars.ContextVar("sql_log", default=None)


@contextmanager
def capture_sql():
    """Collect the SQL statements run inside this block into a list."""
    log = []
    token = _sql_log.set(log)
    try:
        yield log
    finally:
        _sql_log.reset(token)


def log_sql(statement):
    """Add a statement (or comment) to the active debug log, if any."""
    log = _sql_log.get()
    if log is not None:
        log.append(statement)


def _record_sql(conn, cursor, statement, parameters, context, executemany):
    if _sql_log.get() is None:
        return
    # Skip SQLAlchemy/pandas metadata lookups; only the app's queries matter.
    if "pg_catalog" in statement or "information_schema" in statement:
        return
    log_sql(cursor.mogrify(statement, parameters).decode().rstrip() + ";")


def render_sql(sql, params):
    """Return a `:name`-style statement with its parameters merged in, as
    psycopg2 would send it, without running it."""
    engine = get_engine()
    compiled = str(text(sql).compile(dialect=engine.dialect))
    raw = engine.raw_connection()
    try:
        return raw.cursor().mogrify(compiled, params).decode().rstrip() + ";"
    finally:
        raw.close()


def query_df(sql, params=None):
    """Run a raw SQL statement and return the result as a pandas DataFrame."""
    with get_engine().connect() as conn:
        return pd.read_sql(text(sql), conn, params=params or {})


def fetch_seps():
    """Return id/name of every strategic sector, ordered by order_by."""
    schema = get_schema()
    sql = f"select id, name from {schema}.sep where id = 10 order by order_by"
    return query_df(sql)


def fetch_indicators(sep_id):
    """Return id/name of the indicators belonging to a strategic sector, ordered by level, name."""
    schema = get_schema()
    sql = (
        f"select id, name from {schema}.indicator "
        f"where sep_id = :sep_id "
        f"/*and level > 1*/ "
        f"order by level, name"
    )
    return query_df(sql, {"sep_id": sep_id})


def fetch_states():
    """Return id/state of every state, ordered by state name."""
    schema = get_schema()
    sql = f"select id, state from {schema}.state order by state"
    return query_df(sql)


def fetch_counties(state_id):
    """Return id/name of the counties belonging to a state, ordered by name."""
    schema = get_schema()
    sql = f"select id, name from {schema}.county where state_id = :state_id order by name"
    return query_df(sql, {"state_id": state_id})


def _scope_filter(state_id, county_id, alias):
    """WHERE clause + params limiting geoobjects to a state, or to one county.

    county_id is unique across states, so when it's given it's sufficient on
    its own -- state_id is only used when no county_id is provided.
    """
    if county_id:
        return f"{alias}.county_id = :county_id", {"county_id": county_id}
    return f"{alias}.state_id = :state_id", {"state_id": state_id}


def fetch_bounds(state_id, county_id=None):
    """[[west, south], [east, north]] of a state or a municipality (see
    _bounds()), or None if it has no geometry."""
    hits = _bounds.cache_info().hits
    bounds, sql = _bounds(state_id, county_id)
    if _bounds.cache_info().hits > hits:
        log_sql(f"-- served from the server's bounds cache; built by:\n{sql}")
    return bounds


@lru_cache(maxsize=256)
def _bounds(state_id, county_id=None):
    """Extent of the municipality, or of all the state's municipalities
    (geoobjects whose county_id is their own id) -- a few hundred polygons,
    instead of the state's tens of thousands of tracts. Cached: geometry
    doesn't change. Returns (bounds, sql_with_params)."""
    schema = get_schema()
    if county_id:
        where, params = "g.id = :county_id", {"county_id": county_id}
    else:
        where, params = "g.state_id = :state_id and g.county_id = g.id", {"state_id": state_id}
    sql = (
        f"select ST_XMin(e) as w, ST_YMin(e) as s, ST_XMax(e) as e, ST_YMax(e) as n "
        f"from (select ST_Extent(g.geom) as e from {schema}.geoobject g where {where}) t"
    )
    with get_engine().connect() as conn:
        row = conn.execute(text(sql), params).one()
    bounds = None if row.w is None else [[row.w, row.s], [row.e, row.n]]
    return bounds, render_sql(sql, params)


def fetch_legend(indicator_id):
    """Return the indicator's legend items (label, color, minvalue, maxvalue),
    in display order. The last item is usually "Dado indisponível", with no
    value range (minvalue/maxvalue null)."""
    schema = get_schema()
    sql = (
        f"select li.label, li.color, li.minvalue, li.maxvalue "
        f"from {schema}.legend_items li "
        f"join {schema}.indicator i on i.legend_id = li.legend_id "
        f'where i.id = :indicator_id order by li."order"'
    )
    df = query_df(sql, {"indicator_id": indicator_id})
    # NaN isn't valid JSON; send missing range bounds as null.
    return df.astype(object).where(df.notna(), None).to_dict(orient="records")


def fetch_values(indicator_id, state_id, county_id=None):
    """Return the indicator's values and legend colors for a state or county,
    as rows of geoobject_id, value, color (no geometry or labels).

    Reads the base `value` table rather than the `geovalue` materialized view:
    geovalue repeats each geoobject's geometry JSON in every row, so the rows
    for one indicator/state are scattered over ~24 GB and cost one disk read
    each (~10-18 s cold). `value` is narrow, and its rows for a geoobject
    (all indicators) sit together, so this takes ~0.1 s. The joins mirror the
    view's: rows without a matching legend item or county are left out.
    The MATERIALIZED CTEs pin the plan to "geoobjects of the state first,
    then their values" -- left alone, the planner picks a plan ~100x slower.
    The geoobjects are looked up in id order (sorted CTE + LATERAL) so the
    probes walk value_geoobject_covering_idx (geoobject_id, indicator_id,
    year) INCLUDE (value) front to back: with hash order (`IN (...)`) each
    probe was a random read, ~10 ms apiece on this server when cold.
    `offset 0` keeps the planner from flattening the LATERAL subquery into a
    plain join: for big states (SP) it would otherwise hash-join against all
    of the indicator's rows nationwide, read from the table (~200 s cold).
    """
    schema = get_schema()
    where, params = _scope_filter(state_id, county_id, "g")
    params["indicator_id"] = indicator_id
    sql = (
        f"with objs as materialized ("
        f"  select distinct g.id from {schema}.geoobject g "
        f"  where {where} and g.county_id is not null order by g.id"
        f"), vals as materialized ("
        f"  select v.geoobject_id, v.value from objs "
        f"  cross join lateral ("
        f"    select v.geoobject_id, v.value from {schema}.value v "
        f"    where v.geoobject_id = objs.id "
        f"      and v.indicator_id = :indicator_id and v.year < 2027"
        f"    offset 0"
        f"  ) v"
        f") "
        # Legend item: the one with the highest minvalue <= value. Matching
        # `value >= minvalue and value < maxvalue` instead would drop values
        # in the gaps between ranges (0.19 .. 0.20) and at the top bound
        # (1.00 -- 149k tracts for some indicators). Same rule as
        # brasil.classify().
        f"select vals.geoobject_id, vals.value, li.color from vals "
        f"cross join lateral ("
        f"  select li.color from {schema}.legend_items li "
        f"  where li.legend_id = (select legend_id from {schema}.indicator where id = :indicator_id) "
        f"    and (vals.value >= li.minvalue or vals.value is null and li.minvalue is null) "
        f"  order by li.minvalue desc nulls last limit 1"
        f") li"
    )
    df = query_df(sql, params)
    # NaN isn't valid JSON; send missing values as null.
    return df.astype(object).where(df.notna(), None).to_dict(orient="records")


def fetch_geoobject_label(geoobject_id, indicator_id=None):
    """Name and municipality name of one geoobject, as on the state map's
    hover popup. With indicator_id, also its value for that indicator (same
    rows as fetch_values(): year < 2027, latest year first), for the country
    map, which only has the legend class. One probe of
    value_geoobject_covering_idx (geoobject_id, indicator_id, year): ~ms."""
    schema = get_schema()
    params = {"id": geoobject_id}
    value_col = ""
    if indicator_id is not None:
        params["indicator_id"] = indicator_id
        value_col = (
            f", (select v.value from {schema}.value v "
            f"   where v.geoobject_id = g.id and v.indicator_id = :indicator_id and v.year < 2027 "
            f"   order by v.year desc limit 1) as value"
        )
    df = query_df(
        f"select case when g.state is null then g.name::text "
        f"            else concat(g.name, '/', g.state) end as name, "
        f"       c.name::text as county_name{value_col} "
        f"from {schema}.geoobject g left join {schema}.geoobject c on c.id = g.county_id "
        f"where g.id = :id",
        params,
    )
    if not len(df):
        return {"name": None, "county_name": None}
    # NaN isn't valid JSON; send a missing value as null.
    return df.astype(object).where(df.notna(), None).to_dict(orient="records")[0]


# Areas warmed recently (key -> monotonic time) and areas being warmed now,
# so repeated selections of the same state don't queue duplicate reads.
WARM_TTL_SECONDS = 15 * 60
_warmed_at = {}
_warming = set()
_warm_lock = threading.Lock()


def warm_sql(state_id, county_id=None):
    """Return (sql, params) of the query warm_values() runs."""
    schema = get_schema()
    where, params = _scope_filter(state_id, county_id, "g")
    sql = (
        f"with objs as materialized ("
        f"  select distinct g.id from {schema}.geoobject g "
        f"  where {where} and g.county_id is not null order by g.id"
        f") "
        f"select count(v.value) from objs cross join lateral ("
        f"  select v.value from {schema}.value v "
        f"  where v.geoobject_id = objs.id and v.year < 2027"
        f"  offset 0"
        f") v"
    )
    return sql, params


def warm_values(state_id, county_id=None):
    """Read every indicator's values for a state (or county) so the database
    pulls those pages into memory before the user asks for a map.

    The first fetch_values() for an area costs one random disk read per
    geoobject; afterwards every indicator for that area is fast, because a
    geoobject's rows for all indicators are stored together. Running this in
    the background when the area is picked hides that first read. It reads the
    same rows as fetch_values() (all indicators, year < 2027), in the same
    id order, so it warms the same index pages. No-op if the area was warmed in
    the last WARM_TTL_SECONDS or is being warmed now.
    """
    key = (None, county_id) if county_id else (state_id, None)
    with _warm_lock:
        last = _warmed_at.get(key)
        if key in _warming or (last and time.monotonic() - last < WARM_TTL_SECONDS):
            return
        _warming.add(key)
    try:
        sql, params = warm_sql(state_id, county_id)
        with get_engine().connect() as conn:
            conn.execute(text(sql), params).scalar_one()
        with _warm_lock:
            _warmed_at[key] = time.monotonic()
    finally:
        with _warm_lock:
            _warming.discard(key)
