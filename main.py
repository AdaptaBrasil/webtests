import hashlib
import json
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from dotenv import load_dotenv

load_dotenv(override=True)

from fastapi import BackgroundTasks, FastAPI, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from lib import brasil, db

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


def _render_index():
    """index.html with app.js's URL tagged by a hash of its contents
    (/static/app.js?v=<hash>), so a deploy that changes app.js gives it a new
    URL and browsers can't keep running a cached old copy. Computed once at
    startup; restart the server after changing either file.
    """
    app_js_hash = hashlib.sha256((STATIC_DIR / "app.js").read_bytes()).hexdigest()[:12]
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    tag = '<script src="/static/app.js"></script>'
    if tag not in html:
        raise RuntimeError(f"index.html must contain {tag!r} to version app.js")
    return html.replace(tag, f'<script src="/static/app.js?v={app_js_hash}"></script>')


INDEX_HTML = _render_index()

app = FastAPI(title="AdaptaBrasil - Mapa de Indicadores")
app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.middleware("http")
async def debug_sql(request: Request, call_next):
    """With request header `X-Debug-SQL: 1`, return the SQL the request ran
    (parameters merged in) as a URL-encoded JSON list in the `X-Debug-SQL`
    response header. The frontend's "Debug" checkbox shows it."""
    if request.headers.get("x-debug-sql") != "1":
        return await call_next(request)
    with db.capture_sql() as log:
        response = await call_next(request)
    if log:
        # Same search_path the app sets, so PostGIS functions resolve.
        log.insert(0, f"SET search_path TO {db.get_schema()}, public;")
        response.headers["X-Debug-SQL"] = quote(json.dumps(log))
    return response


@app.get("/")
@app.get("/adaptabrasil_webtests")
@app.get("/adaptabrasil_webtests/")
def index():
    # no-cache: browsers revalidate the page on every visit, so they always
    # see the current app.js version below.
    return HTMLResponse(INDEX_HTML, headers={"Cache-Control": "no-cache"})


@app.get("/api/seps")
def api_seps():
    return db.fetch_seps().to_dict(orient="records")


@app.get("/api/indicators")
def api_indicators(sep_id: int = Query(...)):
    return db.fetch_indicators(sep_id).to_dict(orient="records")


@app.get("/api/states")
def api_states():
    return db.fetch_states().to_dict(orient="records")


@app.get("/api/counties")
def api_counties(state_id: int = Query(...)):
    return db.fetch_counties(state_id).to_dict(orient="records")


@app.get("/api/bounds")
def api_bounds(
    state_id: int = Query(...),
    county_id: Optional[int] = Query(None),
):
    """[[west, south], [east, north]] of a state or municipality, to zoom the
    map to it. The polygons themselves come from /api/tiles."""
    bounds = db.fetch_bounds(state_id, county_id)
    db.log_sql(brasil.tile_debug_sql())
    return bounds


@app.get("/api/values")
def api_values(
    indicator_id: int = Query(...),
    state_id: int = Query(...),
    county_id: Optional[int] = Query(None),
):
    return db.fetch_values(indicator_id, state_id, county_id)


@app.get("/api/legend")
def api_legend(indicator_id: int = Query(...)):
    return db.fetch_legend(indicator_id)


@app.post("/api/warm", status_code=202)
def api_warm(
    background_tasks: BackgroundTasks,
    state_id: int = Query(...),
    county_id: Optional[int] = Query(None),
):
    # Returns immediately; the read runs after the response is sent.
    background_tasks.add_task(db.warm_values, state_id, county_id)
    db.log_sql(
        "-- runs in the background after this response "
        "(skipped if this area was warmed in the last 15 min):\n"
        + db.render_sql(*db.warm_sql(state_id, county_id))
    )
    return {"status": "warming"}


# --- vector tiles and the whole-country map (see lib/brasil.py) ---------------

@app.get("/api/tiles/config")
def api_tiles_config():
    return brasil.tiles_config()


@app.get("/api/brasil/ids")
def api_brasil_ids():
    # The tract list only changes when geometry is reloaded; the version in
    # the payload is checked against each class string's.
    return JSONResponse(
        brasil.tract_ids_payload(),
        headers={"Cache-Control": "public, max-age=86400", "Vary": "X-Debug-SQL"},
    )


@app.get("/api/brasil/classes")
def api_brasil_classes(indicator_id: int = Query(...)):
    result = brasil.fetch_classes(indicator_id)
    db.log_sql(brasil.tile_debug_sql())
    return result


@app.get("/api/brasil/counties")
def api_brasil_counties(indicator_id: int = Query(...)):
    """Municipality ids, classes and area-weighted means of the indicator
    (country map below brasil.COUNTY_FILL_MAX_ZOOM). Stored as JSON text."""
    return Response(content=brasil.fetch_county_payload(indicator_id), media_type="application/json")


def _tile_response(z, x, y, kind):
    if not (brasil.MIN_ZOOM <= z <= brasil.TILE_MAX_ZOOM[kind] and 0 <= x < 2 ** z and 0 <= y < 2 ** z):
        return Response(status_code=404)
    return Response(
        content=brasil.fetch_tile(z, x, y, kind),
        media_type="application/x-protobuf",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/tiles/{z}/{x}/{y}.pbf")
def api_tile(z: int, x: int, y: int):
    """Census tract polygons (layer "tracts")."""
    return _tile_response(z, x, y, "tracts")


@app.get("/api/boundaries/{z}/{x}/{y}.pbf")
def api_boundary_tile(z: int, x: int, y: int):
    """State and municipality boundary lines (layers "states", "counties")."""
    return _tile_response(z, x, y, "boundaries")


@app.get("/api/municipalities/{z}/{x}/{y}.pbf")
def api_county_tile(z: int, x: int, y: int):
    """Municipality polygons (layer "counties"), for the country map at low zoom."""
    return _tile_response(z, x, y, "counties")


@app.get("/api/geoobject/{geoobject_id}")
def api_geoobject(geoobject_id: int, indicator_id: Optional[int] = Query(None)):
    """Name and municipality of one geoobject (hover popup); with
    indicator_id, also its value (the country map has only the class)."""
    return db.fetch_geoobject_label(geoobject_id, indicator_id)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
