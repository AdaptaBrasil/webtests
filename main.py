from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

load_dotenv(override=True)

from fastapi import FastAPI, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from lib import db

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="AdaptaBrasil - Mapa de Indicadores")
app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.get("/")
@app.get("/adaptabrasil_webtests")
@app.get("/adaptabrasil_webtests/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


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


@app.get("/api/geovalues")
def api_geovalues(
    indicator_id: int = Query(...),
    state_id: int = Query(...),
    county_id: Optional[int] = Query(None),
):
    return db.fetch_geovalues_geojson(indicator_id, state_id, county_id)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
