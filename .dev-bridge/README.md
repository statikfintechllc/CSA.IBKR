# SFTi DevBridge

**Live iOS PWA ↔ AI Agent Diagnostic Runtime**

A self-contained diagnostic plugin that gives an AI agent real-time observability into a PWA running on an iPhone over LAN. Console intercept, network tracing, storage inspection, screenshot capture, and remote JS evaluation — all through a card-based task queue.

## Quick Start

```bash
# Activate the self-contained venv
source DevBridge/.venv/bin/activate

# Install dependencies (first time only)
pip install -r DevBridge/ai.server/requirements.txt

# Start the bridge server (logs write to DevBridge/server.log automatically)
python3 DevBridge/ai.server/server.py
# → 📡 LAN URL: http://192.168.x.x:8765

# Open on iPhone: visit the LAN URL in Safari
# Tap Share → Add to Home Screen → Open from Home Screen
```

## Integrating DevBridge into a Host PWA

Add two things to the host application:

### 1 — Load the bridge script

```html
<!-- Add before </body> in your host app's HTML -->
<script src="http://<LAN_IP>:8765/bridge.js"></script>
```

The bridge self-initializes, detects the server URL, and begins telemetry capture and card polling with no further configuration.

### 2 — Add a DevBridge entry in the navigation / Advanced Settings

In the app's settings menu or navigation sidebar, add an entry that opens the DevBridge dashboard in a new window or navigates to it:

```html
<!-- Option A: open in browser (fullscreen diagnostic view) -->
<a href="http://<LAN_IP>:8765/" target="_blank" rel="noopener">
  DevBridge Diagnostics
</a>

<!-- Option B: embedded iframe inside an "Advanced Settings" panel -->
<iframe
  id="devbridge-frame"
  src="http://<LAN_IP>:8765/"
  style="width:100%;height:100%;border:none;"
  allow="storage-access"
></iframe>
```

The recommended pattern for future builds is **Option A** — open the DevBridge dashboard at `/` as a separate fullscreen view triggered from an "Advanced Settings" row. This keeps the diagnostic surface completely isolated from the host app's UI and lets the agent observe both the host PWA (via `bridge.js` telemetry) and the DevBridge dashboard simultaneously.

When DevBridge is not needed, remove the `<script>` tag. Zero runtime overhead when disabled.

## Architecture

```
DevBridge/
├── .venv/                          Self-contained Python environment (portable)
├── .pyre_configuration             IDE type-check config
├── server.log                      Server output (written here automatically)
├── ai.server/
│   ├── server.py                   API endpoints + SSE + static file serving
│   └── libs/                       Vendored Python dependencies
├── client/
│   ├── dashboard.html              Main entry point (Liquid Glass UI)
│   ├── bridge.js                   Telemetry capture + card polling + card execution
│   ├── manifest.json               PWA manifest
│   ├── sw.js                       Service worker (pass-through, no caching)
│   └── tabs/                       Diagnostic views
│       ├── telemetry.html          Device/runtime stats
│       ├── cards.html              Card execution history
│       ├── storage.html            localStorage/sessionStorage inspector
│       └── network.html            Real-time latency + resource timing
├── hu.ui/                          UI layer (neural mesh canvas, effects config, CSS)
└── ico/                            SVG icon assets

.dev-bridge
├── debug.imgs
│   ├── bugs
│   │   ├── devbridge  # Bug Screenshots for the devbridge system
│   │   └── system     # Bug Screenshots for the system
│   └── current.state
│       ├── devbridge  # Current State Screenshots for the devbridge system
│       └── system     # Current State Screenshots for the system
├── __init__.py
├── instructions
│   └── anithravity.build.md    # Original Build doc for the SFTi.dev-Bridge system. (For the agent or an inclined developer)
└── README.md    # Integration and usage directions (For all to read and use)
```

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Server status + LAN IP |
| `/log` | POST | Receive telemetry from device |
| `/logs` | GET | Latest N logs |
| `/poll` | GET | Device polls for next card |
| `/card` | POST | Agent pushes a task card |
| `/cards` | GET | Full queue state |
| `/stream` | GET | SSE live feed |

## Card Types

| Type | What It Does |
|---|---|
| `eval` | Execute JS in browser context |
| `screenshot` | Capture viewport as PNG |
| `test` | Run JS assertions, return pass/fail |
| `reload` | Force `location.reload()` |
| `fetch` | Make a network request from device |
| `storage_read` / `storage_write` | Inspect/modify localStorage |

## Full Documentation

See [`.github/instructions/anithravity.build.md`](.github/instructions/anithravity.build.md) for the complete technical reference including safety mechanisms, iOS constraints, and agent workflow.
