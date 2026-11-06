"""Dedicated 127.0.0.1:8766 service; never forwarded by Tailscale Serve.

This service is intentionally NOT mounted on the public/tailnet Web API.
Access requires a browser request from the local 8765 UI, with exact
Host/Origin and a non-simple JSON POST header (CSRF protection).
"""

import asyncio

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from typing import Literal

from tachie_motion.web.native_picker import PickerUnavailable, choose_local_source

PORT = 8766
ORIGINS = frozenset(("http://127.0.0.1:8765", "http://localhost:8765"))
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
dialog_lock = asyncio.Lock()


class PickerRequest(BaseModel):
    kind: Literal["psd", "wav", "output_dir"]
    initial_dir: str | None = None


@app.middleware("http")
async def only_local_editor(request: Request, call_next):
    if request.headers.get("host") != f"127.0.0.1:{PORT}":
        return JSONResponse({"detail": "Invalid picker host"}, status_code=403)
    if not request.client or request.client.host != "127.0.0.1":
        return JSONResponse({"detail": "Remote picker requests are forbidden"}, status_code=403)
    origin = request.headers.get("origin")
    if origin not in ORIGINS:
        return JSONResponse({"detail": "Local editor origin required"}, status_code=403)
    cors = {"Access-Control-Allow-Origin": origin, "Vary": "Origin"}
    if request.method == "OPTIONS" and request.url.path == "/pick":
        method = request.headers.get("access-control-request-method", "").upper()
        requested = {x.strip().lower() for x in
                     request.headers.get("access-control-request-headers", "").split(",") if x.strip()}
        if method != "POST" or not requested.issubset({"content-type", "x-tachie-picker"}):
            return JSONResponse({"detail": "Invalid preflight"}, status_code=403)
        return Response(status_code=204, headers={
            **cors, "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type, X-Tachie-Picker",
        })
    if request.method == "POST":
        if request.url.path != "/pick":
            return JSONResponse({"detail": "Unknown picker action"}, status_code=404, headers=cors)
        if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            return JSONResponse({"detail": "JSON required"}, status_code=415, headers=cors)
        if request.headers.get("x-tachie-picker") != "1":
            return JSONResponse({"detail": "Picker request header required"}, status_code=403, headers=cors)
    elif request.method != "GET" or request.url.path != "/health":
        return JSONResponse({"detail": "Not found"}, status_code=404, headers=cors)
    response = await call_next(request)
    response.headers.update(cors)
    return response


@app.get("/health")
def health():
    return {"picker": "mac-local", "ready": True}


@app.post("/pick")
async def pick(payload: PickerRequest):
    if dialog_lock.locked():
        raise HTTPException(status_code=409, detail="A Finder dialog is already open")
    async with dialog_lock:
        try:
            return await asyncio.to_thread(
                choose_local_source, payload.kind, initial_dir=payload.initial_dir
            )
        except PickerUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
