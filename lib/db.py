import os
import json
import math
from functools import lru_cache

import pandas as pd
from sqlalchemy import create_engine, text
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
    return create_engine(url, echo=echo)


@lru_cache(maxsize=1)
def get_schema():
    """Return the Postgres schema that holds the application tables."""
    return _require("DB_SCHEMA")


def query_df(sql, params=None):
    """Run a raw SQL statement and return the result as a pandas DataFrame."""
    with get_engine().connect() as conn:
        return pd.read_sql(text(sql), conn, params=params or {})


def fetch_seps():
    """Return id/name of every strategic sector, ordered by order_by."""
    schema = get_schema()
    sql = f"select id, name from {schema}.sep order by order_by"
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


# Whole-state requests can span tens of thousands of sub-county polygons, so
# their boundaries are simplified in degrees (~55m at Brazil's latitude) --
# finer detail than that isn't visible at state zoom anyway. County-scoped
# requests cover few enough polygons that they're served at full resolution.
STATE_VIEW_SIMPLIFY_TOLERANCE = 0.0005


def fetch_geovalues(indicator_id, state_id, county_id=None):
    """Return the geovalue rows matching the given filters, geometry included.

    county_id is unique across states, so when it's given it's sufficient on
    its own -- state_id is only used to scope the query when no county_id is
    provided.
    """
    schema = get_schema()
    params = {"indicator_id": indicator_id}
    if county_id:
        sql = (
            f"select indicator_id, state_id, county_id, value, color, geompropertiesasjson "
            f"from {schema}.geovalue "
            f"where indicator_id = :indicator_id and year < 2027 and county_id = :county_id"
        )
        params["county_id"] = county_id
    else:
        sql = (
            f"select gv.indicator_id, gv.state_id, gv.county_id, gv.value, gv.color, "
            f"       ST_AsGeoJSON(ST_SimplifyPreserveTopology(go.geom, :tolerance), 4) as geompropertiesasjson "
            f"from {schema}.geovalue gv "
            f"join {schema}.geoobject go on go.id = gv.geoobject_id "
            f"where gv.indicator_id = :indicator_id and gv.year < 2027 and gv.state_id = :state_id"
        )
        params["state_id"] = state_id
        params["tolerance"] = STATE_VIEW_SIMPLIFY_TOLERANCE
    return query_df(sql, params)


def fetch_geovalues_geojson(indicator_id, state_id, county_id=None):
    """Return the filtered geovalue rows as a GeoJSON FeatureCollection dict."""
    df = fetch_geovalues(indicator_id, state_id, county_id)

    features = []
    for row in df.to_dict(orient="records"):
        geometry = row.pop("geompropertiesasjson")
        if isinstance(geometry, str):
            geometry = json.loads(geometry)
        if isinstance(geometry, dict) and geometry.get("type") == "Feature":
            geometry = geometry.get("geometry")
        for key, val in row.items():
            if isinstance(val, float) and math.isnan(val):
                row[key] = None
        features.append({"type": "Feature", "geometry": geometry, "properties": row})

    return {"type": "FeatureCollection", "features": features}
