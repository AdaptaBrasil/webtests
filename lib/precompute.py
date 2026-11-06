"""Precompute the whole-country (Brasil) map caches (see lib/brasil.py).

    python -m lib.precompute              # class strings, tract tiles, boundary tiles
    python -m lib.precompute classes      # only the class strings
    python -m lib.precompute tiles [MAX_ZOOM]
    python -m lib.precompute boundaries [MAX_ZOOM]

In Docker: docker compose exec app python -m lib.precompute

Class strings: one sequential read of `value` (~3-5 min) builds every
indicator of the tract sector at once. Tiles: builds the zoom levels used to
view the country (MIN_ZOOM..PRECOMPUTE_MAX_ZOOM, ~1500 tiles at z9 alone),
skipping tiles already stored; safe to stop and rerun. Higher zooms cover
small areas and are built on demand.
"""
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from dotenv import load_dotenv

load_dotenv(override=True)

from sqlalchemy import text  # noqa: E402

from lib import brasil, db  # noqa: E402

TILE_WORKERS = 4


def precompute_classes():
    brasil.ensure_tables()
    schema = db.get_schema()
    _, version = brasil._tract_ids()
    indicators = db.query_df(
        f"select id from {schema}.indicator where sep_id = :sep_id order by id",
        {"sep_id": brasil.TRACT_SEP_ID},
    )["id"].tolist()
    legends = {i: db.fetch_legend(i) for i in indicators}
    print(f"class strings for {len(indicators)} indicators (one pass over `value`)...", flush=True)

    t0 = time.time()
    done = set()
    with db.get_engine().begin() as conn:
        # One sequential scan + sort, grouped by indicator. Left to itself
        # the planner walks the indicator_id index: one random read per row.
        conn.execute(text("set local enable_indexscan = off"))
        conn.execute(text("set local enable_bitmapscan = off"))
        conn.execute(text("set local enable_hashagg = off"))
        conn.execute(text("set local work_mem = '256MB'"))
        conn.execute(text("set local statement_timeout = 0"))
        rows = conn.execution_options(stream_results=True, yield_per=1).execute(
            text(
                f"select indicator_id, array_agg(geoobject_id), array_agg(year), array_agg(value) "
                f"from {schema}.value "
                f"where year < 2027 and indicator_id in "
                f"  (select id from {schema}.indicator where sep_id = :sep_id) "
                f"group by indicator_id"
            ),
            {"sep_id": brasil.TRACT_SEP_ID},
        )
        results = []
        for indicator_id, ids, years, values in rows:
            classes = brasil.class_string(ids, years, values, legends[indicator_id])
            results.append((indicator_id, classes))
            done.add(indicator_id)
            print(f"  {indicator_id}: {len(ids)} values  ({time.time() - t0:.0f}s)", flush=True)
    # Indicators without tract values: store all "-" so the map doesn't
    # rescan `value` looking for them.
    empty = "-" * len(brasil._tract_ids()[0])
    results += [(i, empty) for i in indicators if i not in done]
    with db.get_engine().begin() as conn:
        for indicator_id, classes in results:
            brasil.store_classes(conn, indicator_id, version, classes)
    print(f"stored {len(results)} class strings in {time.time() - t0:.0f}s", flush=True)


def precompute_tiles(max_zoom=brasil.PRECOMPUTE_MAX_ZOOM, kind="tracts"):
    brasil.ensure_tables()
    schema = db.get_schema()
    for z in range(brasil.MIN_ZOOM, max_zoom + 1):
        have = set(
            map(tuple, db.query_df(
                f"select x, y from {schema}.{brasil.TILE_TABLES[kind]} where z = :z", {"z": z}
            ).itertuples(index=False))
        )
        todo = [t for t in brasil.brazil_tiles(z) if t not in have]
        print(f"{kind} z{z}: {len(todo)} tiles to build ({len(have)} already stored)", flush=True)
        t0 = time.time()
        size = 0
        with ThreadPoolExecutor(TILE_WORKERS) as pool:
            futures = {pool.submit(brasil.build_tile, z, x, y, kind): (x, y) for x, y in todo}
            for n, future in enumerate(as_completed(futures), 1):
                size += len(future.result())
                if n % 50 == 0 or n == len(todo):
                    print(f"  {kind} z{z}: {n}/{len(todo)}  {size / 1e6:.1f} MB  ({time.time() - t0:.0f}s)", flush=True)


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("all", "classes"):
        precompute_classes()
    max_zoom = int(sys.argv[2]) if len(sys.argv) > 2 else brasil.PRECOMPUTE_MAX_ZOOM
    if what in ("all", "tiles"):
        precompute_tiles(max_zoom, "tracts")
    if what in ("all", "boundaries"):
        precompute_tiles(max_zoom, "boundaries")
