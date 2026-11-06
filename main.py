import hashlib
import json
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from dotenv import load_dotenv

load_dotenv(override=True)

from fastapi import BackgroundTasks, FastAPI, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from lib import db

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


@app.get("/api/geometry")
def api_geometry(
    state_id: int = Query(...),
    county_id: Optional[int] = Query(None),
):
    # Geoobject boundaries don't change between indicators, so let the browser
    # cache them too.
    return Response(
        content=db.fetch_geometry_geojson(state_id, county_id),
        media_type="application/json",
        # Vary: a cached copy without debug SQL mustn't answer a debug request.
        headers={"Cache-Control": "public, max-age=86400", "Vary": "X-Debug-SQL"},
    )


@app.get("/api/values")
def api_values(
    indicator_id: int = Query(...),
    state_id: int = Query(...),
    county_id: Optional[int] = Query(None),
):
    return db.fetch_values(indicator_id, state_id, county_id)


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


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
