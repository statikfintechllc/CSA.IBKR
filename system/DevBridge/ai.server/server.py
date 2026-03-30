import sys
import os

# DevBridge root: two levels up from DevBridge/ai.server/server.py
DEVBRIDGE_DIR = os.path.dirname(os.path.dirname(__file__))
BASE_DIR = os.path.dirname(DEVBRIDGE_DIR)

# Add vendored libs for portability and IDE diagnostics
VENDORED_LIBS = os.path.join(DEVBRIDGE_DIR, "ai.server", "libs")
if os.path.exists(VENDORED_LIBS):
    sys.path.insert(0, VENDORED_LIBS)

import asyncio
import json
import logging
import socket
import time
import uuid
from collections import deque
from datetime import datetime
from typing import Any, Deque, Dict, List, Optional, Union
import itertools

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse
import uvicorn
# (os already imported above)

# Configuration
PORT = 8765
MAX_LOGS = 1000
MAX_CARDS = 100

# Logging — always writes to DevBridge/server.log regardless of launch directory
LOG_FILE = os.path.join(DEVBRIDGE_DIR, "server.log")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_FILE)
    ]
)
logger = logging.getLogger("devbridge")

app = FastAPI(title="SFTi DevBridge")

# CORS - Allow everything for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory storage
LOG_QUEUE: Deque[Dict[str, Any]] = deque(maxlen=MAX_LOGS)
CARD_QUEUE: List[Dict[str, Any]] = []  # Status tracking: pending, delivered, completed, failed
SSE_LISTENERS: List[asyncio.Queue] = []

class LogPayload(BaseModel):
    ts: float = Field(default_factory=time.time)
    source: str
    level: str
    message: str
    stack: Optional[str] = None
    url: Optional[str] = None
    data: Dict[str, Any] = Field(default_factory=dict)

class CardPayload(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    type: str
    payload: Any
    created: float = Field(default_factory=time.time)
    status: str = "pending"

async def broadcast_sse(event_type: str, data: Any):
    payload = {"type": event_type, "data": data, "ts": time.time()}
    message = json.dumps(payload, default=str)
    dead = []
    for q in SSE_LISTENERS:
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        SSE_LISTENERS.remove(q)

def get_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

@app.get("/health")
async def health():
    return {
        "status": "online",
        "ip": get_lan_ip(),
        "port": PORT,
        "logs_count": len(LOG_QUEUE),
        "cards_pending": len([c for c in CARD_QUEUE if c["status"] == "pending"])
    }

@app.post("/log")
async def receive_log(log: LogPayload):
    """Receive a telemetry log event from the device."""
    log_dict = log.model_dump()
    LOG_QUEUE.append(log_dict)
    try:
        await broadcast_sse("log", log_dict)
    except Exception:
        pass
    return {"status": "ok"}

@app.get("/poll")
async def poll_cards():
    # Return the first pending card
    for card in CARD_QUEUE:
        if card["status"] == "pending":
            card["status"] = "delivered"
            try:
                await broadcast_sse("card_update", card)
            except Exception:
                pass
            return {"card": card}
    return {"card": None}

@app.post("/card")
async def push_card(card: CardPayload):
    """Push a new command card into the queue for the device to process."""
    card_dict = card.model_dump()
    CARD_QUEUE.append(card_dict)
    if len(CARD_QUEUE) > MAX_CARDS:
        CARD_QUEUE.pop(0)
    try:
        await broadcast_sse("card_new", card_dict)
    except Exception:
        pass
    return {"status": "enqueued", "id": card_dict["id"]}

@app.post("/card/{card_id}/status")
async def update_card_status(card_id: str, update: Dict[str, str]):
    """Update the status of an existing card."""
    for card in CARD_QUEUE:
        if card["id"] == card_id:
            card["status"] = update.get("status", card["status"])
            return {"status": "updated"}
    return JSONResponse(status_code=404, content={"error": "card not found"})

@app.get("/cards")
async def get_cards():
    """Retrieve all cards currently in the queue."""
    return JSONResponse(content=CARD_QUEUE)

@app.get("/logs")
async def get_logs(limit: int = 100):
    """Retrieve the LATEST n logs, truncating massive payloads."""
    snapshot = list(LOG_QUEUE)
    recent = snapshot[-limit:]
    recent.reverse()

    pruned = []
    for log in recent:
        entry = dict(log)
        data = entry.get('data')
        if isinstance(data, dict):
            result = data.get('result')
            if isinstance(result, str) and len(result) > 5000:
                entry = dict(entry)
                entry['data'] = dict(data)
                entry['data']['result'] = result[:200] + "... [TRUNCATED]"
        pruned.append(entry)
    return JSONResponse(content=pruned)

@app.get("/stream")
async def sse_stream(request: Request):
    queue = asyncio.Queue()
    SSE_LISTENERS.append(queue)
    
    async def event_generator():
        try:
            while True:
                # Check if client disconnected
                if await request.is_disconnected():
                    break
                data = await queue.get()
                yield data
        except Exception as e:
            logger.error(f"SSE Error: {e}")
        finally:
            if queue in SSE_LISTENERS:
                SSE_LISTENERS.remove(queue)

    return EventSourceResponse(event_generator())

# Serve DevBridge/client assets — dashboard.html is the main entry point
CLIENT_DIR = os.path.join(DEVBRIDGE_DIR, "client")
DASHBOARD = os.path.join(CLIENT_DIR, "dashboard.html")

@app.get("/", include_in_schema=False)
async def serve_dashboard():
    if os.path.exists(DASHBOARD):
        return FileResponse(DASHBOARD)
    return JSONResponse(status_code=404, content={"error": "dashboard.html not found"})

if os.path.exists(CLIENT_DIR):
    app.mount("/", StaticFiles(directory=CLIENT_DIR), name="static")
    logger.info(f"Mounted DevBridge/client at /")
else:
    logger.warning(f"Client directory not found at {CLIENT_DIR}")

if __name__ == "__main__":
    lan_ip = get_lan_ip()
    print(f"\n🚀 SFTi DevBridge starting...")
    print(f"📡 LAN URL: http://{lan_ip}:{PORT}")
    print(f"🔗 Local URL: http://127.0.0.1:{PORT}\n")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
