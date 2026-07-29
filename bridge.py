#!/usr/bin/env python3
"""
StudioPilot Bridge
==================

Local bridge that connects the StudioPilot browser extension (running inside a
Claude / ChatGPT / Arena AI chat page) to the StudioPilot plugin running inside
Roblox Studio.

Architecture
------------
    AI chat page (browser extension)
            |  WebSocket  ws://127.0.0.1:<extension_port>/ws
            v
        bridge.py  <-- this file
            ^  HTTP long-poll  http://127.0.0.1:<studio_port>/api/poll
            |
    Roblox Studio plugin (HttpService; Roblox has no WebSocket client)

The extension sends `execute` jobs over the WebSocket. The bridge queues them
and hands them to the Studio plugin the next time it long-polls. The plugin
executes the commands with full Studio permissions and POSTs the results back;
the bridge then resolves the pending WebSocket request.

Only stdlib + the `websockets` package are required.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

VERSION = "1.0.0"
BASE_DIR = Path(__file__).resolve().parent
LOG_DIR = BASE_DIR / "logs"
PID_FILE = LOG_DIR / "bridge.pid"

DEFAULT_CONFIG = {
    "extension_port": 17654,
    "studio_port": 17655,
    "job_timeout_s": 180,
    "poll_max_wait_s": 25,
    "studio_offline_after_s": 45,
    "max_commands_per_job": 64,
}

log = logging.getLogger("studiopilot.bridge")


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    cfg_path = BASE_DIR / "config.json"
    try:
        if cfg_path.exists():
            with open(cfg_path, "r", encoding="utf-8") as fh:
                user_cfg = json.load(fh)
            for key in cfg:
                if key in user_cfg:
                    cfg[key] = user_cfg[key]
    except Exception as exc:  # noqa: BLE001 - never let a bad config kill the bridge
        log.warning("Could not read config.json (%s); using defaults", exc)
    # CLI overrides: --extension-port=, --studio-port=
    for arg in sys.argv[1:]:
        if arg.startswith("--") and "=" in arg:
            key, _, value = arg[2:].partition("=")
            key = key.replace("-", "_")
            if key in cfg:
                try:
                    cfg[key] = int(value)
                except ValueError:
                    log.warning("Ignoring non-numeric override %s", arg)
    return cfg


# --------------------------------------------------------------------------
# Shared bridge state
# --------------------------------------------------------------------------

class Job:
    __slots__ = ("id", "client", "commands", "created_at", "future", "delivered")

    def __init__(self, client, commands):
        self.id = uuid.uuid4().hex[:12]
        self.client = client
        self.commands = commands
        self.created_at = time.time()
        self.future: asyncio.Future | None = None
        self.delivered = False


class BridgeState:
    """Holds everything shared between the asyncio loop and HTTP threads."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.loop: asyncio.AbstractEventLoop | None = None

        # asyncio side (only touched from the loop thread)
        self.job_queue: asyncio.Queue[Job] | None = None
        self.ext_clients: set = set()
        self.active_ext = None
        self.pending_jobs: dict[str, Job] = {}

        # cross-thread: HTTP long-poll threads wait on this condition while the
        # asyncio dispatcher publishes the current job under the same lock.
        self.cond = threading.Condition()
        self.current_job: Job | None = None

        # plugin liveness (HTTP threads update, both sides read)
        self.last_poll_at = 0.0
        self.plugin_info: dict = {}
        self._studio_was_connected = False

    # -- plugin liveness ----------------------------------------------------
    def mark_poll(self, info: dict | None = None):
        self.last_poll_at = time.time()
        if info:
            self.plugin_info = {k: v for k, v in info.items() if v is not None}

    @property
    def studio_connected(self) -> bool:
        if not self.last_poll_at:
            return False
        return (time.time() - self.last_poll_at) < float(self.cfg["studio_offline_after_s"])

    def status_payload(self) -> dict:
        return {
            "type": "status",
            "studioConnected": self.studio_connected,
            "plugin": self.plugin_info,
            "activeClients": len(self.ext_clients),
            "pendingJobs": len(self.pending_jobs) + (1 if self.current_job else 0),
            "bridgeVersion": VERSION,
            "ts": time.time(),
        }


STATE: BridgeState | None = None


# --------------------------------------------------------------------------
# Command validation (bridge-side sanity check; the plugin re-validates)
# --------------------------------------------------------------------------

KNOWN_ACTIONS = {
    "ping",
    "get_scripts",
    "read_script",
    "set_script",
    "create_script",
    "delete_script",
    "run_code",
    "get_tree",
    "set_property",
    "insert_asset",
    "get_console_output",
    "get_selection",
}

REQUIRED_PARAMS = {
    "read_script": ("path",),
    "set_script": ("path", "source"),
    "create_script": ("path", "source"),
    "delete_script": ("path",),
    "run_code": ("code",),
    "set_property": ("path", "property", "value"),
    "insert_asset": ("assetId",),
}


def validate_commands(raw) -> tuple[list, str | None]:
    """Return (commands, error). Unknown actions are allowed through (the plugin
    answers with an error for them) so new plugin commands keep working with an
    older bridge; only structurally broken entries are rejected here."""
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list):
        return [], "commands must be a list"
    if not raw:
        return [], "commands list is empty"
    if len(raw) > STATE.cfg["max_commands_per_job"]:
        return [], f"too many commands ({len(raw)} > {STATE.cfg['max_commands_per_job']})"
    cleaned = []
    for i, cmd in enumerate(raw):
        if not isinstance(cmd, dict):
            return [], f"command #{i + 1} is not an object"
        action = cmd.get("action")
        if not isinstance(action, str) or not action:
            return [], f"command #{i + 1} has no 'action' string"
        missing = [p for p in REQUIRED_PARAMS.get(action, ()) if p not in cmd]
        if missing:
            return [], f"command #{i + 1} ({action}) missing: {', '.join(missing)}"
        cleaned.append(cmd)
    return cleaned, None


# --------------------------------------------------------------------------
# WebSocket side (extension <-> bridge)
# --------------------------------------------------------------------------

WS_PATH = "/ws"


async def ws_send(ws, payload: dict):
    try:
        await ws.send(json.dumps(payload, ensure_ascii=False))
        return True
    except Exception as exc:  # noqa: BLE001
        log.debug("ws send failed: %s", exc)
        return False


async def broadcast_status():
    payload = STATE.status_payload()
    dead = []
    for ws in list(STATE.ext_clients):
        if not await ws_send(ws, payload):
            dead.append(ws)
    for ws in dead:
        STATE.ext_clients.discard(ws)


async def run_job(ws, req_id, commands):
    """Queue a job and deliver its result back to the requesting socket."""
    job = Job(client=ws, commands=commands)
    job.future = STATE.loop.create_future()
    STATE.pending_jobs[job.id] = job
    await STATE.job_queue.put(job)
    log.info("Job %s queued (%d command%s)", job.id, len(commands), "s" if len(commands) > 1 else "")
    try:
        results = await job.future
        await ws_send(ws, {"type": "result", "id": req_id, "jobId": job.id, "ok": True, "results": results})
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "timed out" in msg or isinstance(exc, asyncio.TimeoutError):
            msg = "timeout"
        await ws_send(ws, {"type": "result", "id": req_id, "jobId": job.id, "ok": False, "error": msg})
    finally:
        STATE.pending_jobs.pop(job.id, None)


async def ws_handler(ws):
    # websockets >= 11 gives the path on the connection object
    path = getattr(ws.request, "path", "/") if hasattr(ws, "request") else getattr(ws, "path", "/")
    remote = getattr(ws, "remote_address", None)
    log.info("Extension connected: %s path=%s", remote, path)
    STATE.ext_clients.add(ws)
    if STATE.active_ext is None:
        STATE.active_ext = ws
    await ws_send(ws, {"type": "hello", "bridge": "studiopilot", "version": VERSION})
    await ws_send(ws, STATE.status_payload())

    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except (TypeError, ValueError):
                await ws_send(ws, {"type": "error", "error": "bad_json"})
                continue
            if not isinstance(msg, dict):
                await ws_send(ws, {"type": "error", "error": "bad_message"})
                continue

            mtype = msg.get("type")
            if mtype == "hello":
                await ws_send(ws, {"type": "hello", "bridge": "studiopilot", "version": VERSION})
                await ws_send(ws, STATE.status_payload())
            elif mtype == "status_request":
                await ws_send(ws, STATE.status_payload())
            elif mtype == "execute":
                req_id = msg.get("id") or uuid.uuid4().hex[:12]
                if len(STATE.pending_jobs) >= 8:
                    await ws_send(ws, {"type": "result", "id": req_id, "ok": False, "error": "busy: too many pending jobs"})
                    continue
                commands, err = validate_commands(msg.get("commands"))
                if err:
                    await ws_send(ws, {"type": "result", "id": req_id, "ok": False, "error": err})
                    continue
                if not STATE.studio_connected:
                    await ws_send(ws, {
                        "type": "result", "id": req_id, "ok": False,
                        "error": "studio_offline: Roblox Studio plugin is not connected. "
                                 "Open Studio, load a place and toggle StudioPilot ON.",
                    })
                    continue
                asyncio.ensure_future(run_job(ws, req_id, commands))
            elif mtype == "ping":
                await ws_send(ws, {"type": "pong", "ts": time.time()})
            else:
                await ws_send(ws, {"type": "error", "error": f"unknown type: {mtype}"})
    except Exception as exc:  # noqa: BLE001 - connection closed, etc.
        log.debug("ws handler ended: %s", exc)
    finally:
        STATE.ext_clients.discard(ws)
        if STATE.active_ext is ws:
            STATE.active_ext = next(iter(STATE.ext_clients), None)
        log.info("Extension disconnected: %s (remaining: %d)", remote, len(STATE.ext_clients))


# --------------------------------------------------------------------------
# Job dispatcher (asyncio side)
# --------------------------------------------------------------------------

async def dispatcher():
    """FIFO: pop a job, publish it for HTTP long-pollers, await its result."""
    while True:
        job: Job = await STATE.job_queue.get()
        timeout_s = float(STATE.cfg["job_timeout_s"])
        with STATE.cond:
            STATE.current_job = job
            STATE.cond.notify_all()
        log.info("Job %s waiting for Studio plugin (timeout %ss)", job.id, timeout_s)
        try:
            await asyncio.wait_for(asyncio.shield(job.future), timeout=timeout_s)
            log.info("Job %s done", job.id)
        except asyncio.TimeoutError:
            log.warning("Job %s timed out after %ss", job.id, timeout_s)
            if not job.future.done():
                job.future.set_exception(asyncio.TimeoutError("timeout: Studio did not answer"))
        except Exception as exc:  # noqa: BLE001
            log.warning("Job %s failed: %s", job.id, exc)
            if not job.future.done():
                job.future.set_exception(exc)
        finally:
            with STATE.cond:
                if STATE.current_job is job:
                    STATE.current_job = None
                    STATE.cond.notify_all()


async def status_watcher():
    """Push status changes (studio connect/disconnect) to all extension tabs."""
    last = None
    while True:
        await asyncio.sleep(2)
        connected = STATE.studio_connected
        if connected != last:
            last = connected
            log.info("Studio %s", "connected" if connected else "disconnected")
            if connected:
                log.info("  plugin info: %s", STATE.plugin_info)
            await broadcast_status()
        # periodic heartbeat status so late-loading tabs sync up
        elif int(time.time()) % 10 < 2:
            await broadcast_status()


# --------------------------------------------------------------------------
# HTTP side (Roblox Studio plugin <-> bridge)
# --------------------------------------------------------------------------

def _json_bytes(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


class StudioHTTPHandler(BaseHTTPRequestHandler):
    server_version = f"StudioPilotBridge/{VERSION}"
    protocol_version = "HTTP/1.1"  # keep-alive so HttpService does not reconnect each call

    # -- plumbing -----------------------------------------------------------
    def log_message(self, fmt, *args):  # route BaseHTTPRequestHandler logs into logging
        log.debug("http %s - %s", self.client_address[0], fmt % args)

    def _send_json(self, obj, status=200):
        body = _json_bytes(obj)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _body_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 32 * 1024 * 1024:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return None

    # -- routes ---------------------------------------------------------------
    def do_GET(self):  # noqa: N802 (stdlib naming)
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/")
        if route in ("", "/", "/api/status"):
            self._send_json({
                "ok": True,
                "name": "studiopilot-bridge",
                "version": VERSION,
                "studioConnected": STATE.studio_connected,
                "plugin": STATE.plugin_info,
                "pendingJobs": len(STATE.pending_jobs) + (1 if STATE.current_job else 0),
            })
            return
        if route == "/api/poll":
            params = parse_qs(parsed.query)
            try:
                wait_s = min(float(params.get("wait", [STATE.cfg["poll_max_wait_s"]])[0]),
                             float(STATE.cfg["poll_max_wait_s"]))
            except (TypeError, ValueError):
                wait_s = float(STATE.cfg["poll_max_wait_s"])
            info = {}
            for key in ("place", "placeId", "pluginVersion"):
                if key in params:
                    info[key] = params[key][0]
            STATE.mark_poll(info)

            deadline = time.time() + max(wait_s, 0.5)
            job = None
            with STATE.cond:
                while True:
                    cur = STATE.current_job
                    if cur is not None and not cur.delivered and cur.future is not None and not cur.future.done():
                        cur.delivered = True
                        job = cur
                        break
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        break
                    STATE.cond.wait(timeout=remaining)
            if job is None:
                self._send_json({"commands": None})
            else:
                log.info("Job %s delivered to Studio plugin", job.id)
                self._send_json({"id": job.id, "commands": job.commands})
            return
        self._send_json({"ok": False, "error": "not_found"}, status=404)

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/")
        STATE.mark_poll()
        if route != "/api/result":
            self._send_json({"ok": False, "error": "not_found"}, status=404)
            return
        payload = self._body_json()
        if not isinstance(payload, dict):
            self._send_json({"ok": False, "error": "bad_json"}, status=400)
            return
        job_id = payload.get("id")
        results = payload.get("results")
        job = STATE.current_job
        if job is None or job.id != job_id:
            self._send_json({"ok": False, "error": "unknown_or_stale_job"}, status=409)
            return
        if not isinstance(results, list):
            self._send_json({"ok": False, "error": "results must be a list"}, status=400)
            return
        loop = STATE.loop
        future = job.future
        if loop is None or future is None or future.done():
            self._send_json({"ok": False, "error": "job_already_finished"}, status=409)
            return

        def _resolve():
            if not future.done():
                future.set_result(results)

        loop.call_soon_threadsafe(_resolve)
        log.info("Job %s results received (%d)", job_id, len(results))
        self._send_json({"ok": True})


# --------------------------------------------------------------------------
# Startup helpers
# --------------------------------------------------------------------------

def try_reclaim_port(port: int) -> bool:
    """Kill a leftover StudioPilot bridge from an earlier run that still holds
    the extension/studio port. Only kills processes that look like OUR bridge
    (cmdline contains bridge.py) or match our pid file."""
    killed = False
    # 1) pid file from a previous run
    try:
        if PID_FILE.exists():
            pid = int(PID_FILE.read_text().strip())
            if pid != os.getpid() and _pid_is_our_bridge(pid):
                _kill_pid(pid)
                killed = True
    except Exception as exc:  # noqa: BLE001
        log.debug("pid file reclaim: %s", exc)
    # 2) platform port scan (best effort)
    try:
        pids = _pids_on_port(port)
        for pid in pids:
            if pid != os.getpid() and _pid_is_our_bridge(pid):
                _kill_pid(pid)
                killed = True
    except Exception as exc:  # noqa: BLE001
        log.debug("port scan reclaim: %s", exc)
    if killed:
        time.sleep(1.0)
    return killed


def _pid_is_our_bridge(pid: int) -> bool:
    try:
        if platform.system() == "Windows":
            out = subprocess.run(
                ["wmic", "process", "where", f"ProcessId={pid}", "get", "CommandLine", "/value"],
                capture_output=True, text=True, timeout=5,
            ).stdout
            return "bridge.py" in out
        cmdline = Path(f"/proc/{pid}/cmdline")
        if cmdline.exists():
            return "bridge.py" in cmdline.read_text(errors="replace")
        out = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                             capture_output=True, text=True, timeout=5).stdout
        return "bridge.py" in out
    except Exception:  # noqa: BLE001
        return False


def _kill_pid(pid: int):
    log.info("Killing leftover bridge process pid=%s", pid)
    if platform.system() == "Windows":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                       capture_output=True, timeout=10)
    else:
        os.kill(pid, signal.SIGTERM)


def _pids_on_port(port: int) -> list:
    if platform.system() == "Windows":
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=10).stdout
        pids = set()
        for line in out.splitlines():
            if f":{port}" in line and ("LISTEN" in line.upper()):
                parts = line.split()
                if parts and parts[-1].isdigit():
                    pids.add(int(parts[-1]))
        return sorted(pids)
    out = subprocess.run(["lsof", "-ti", f":{port}"], capture_output=True, text=True, timeout=10).stdout
    return [int(x) for x in out.split() if x.strip().isdigit()]


def setup_logging():
    LOG_DIR.mkdir(exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%H:%M:%S")
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    console = logging.StreamHandler()
    console.setFormatter(fmt)
    console.setLevel(logging.INFO)
    root.addHandler(console)
    try:
        fileh = logging.FileHandler(LOG_DIR / "bridge.log", encoding="utf-8")
        fileh.setFormatter(fmt)
        fileh.setLevel(logging.DEBUG)
        root.addHandler(fileh)
    except OSError as exc:
        log.warning("could not open log file: %s", exc)


async def main_async(cfg: dict):
    global STATE
    STATE = BridgeState(cfg)
    STATE.loop = asyncio.get_running_loop()
    STATE.job_queue = asyncio.Queue()

    # websockets API differs between versions; use the modern asyncio one
    # (websockets >= 10.1) and fall back to the legacy module-level serve().
    try:
        from websockets.asyncio.server import serve as ws_serve  # type: ignore
    except ImportError:  # pragma: no cover - older websockets
        from websockets import serve as ws_serve  # type: ignore

    ext_port = int(cfg["extension_port"])
    try:
        server = await ws_serve(ws_handler, "127.0.0.1", ext_port)
    except OSError:
        log.warning("Port %d busy; trying to reclaim it from a previous bridge...", ext_port)
        if try_reclaim_port(ext_port):
            server = await ws_serve(ws_handler, "127.0.0.1", ext_port)
        else:
            raise

    dispatcher_task = asyncio.ensure_future(dispatcher())
    watcher_task = asyncio.ensure_future(status_watcher())
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):  # Windows
            pass

    log.info("Extension WebSocket listening on ws://127.0.0.1:%d%s", ext_port, WS_PATH)
    try:
        await stop.wait()
    finally:
        try:
            server.close()
            await server.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        dispatcher_task.cancel()
        watcher_task.cancel()
        for job in list(STATE.pending_jobs.values()):
            if job.future and not job.future.done():
                job.future.set_exception(RuntimeError("bridge shutting down"))
        others = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
        for t in others:
            t.cancel()
        if others:
            await asyncio.gather(*others, return_exceptions=True)


def main():
    setup_logging()
    cfg = load_config()
    LOG_DIR.mkdir(exist_ok=True)
    PID_FILE.write_text(str(os.getpid()))

    banner = f"""
  =============================================
    StudioPilot Bridge v{VERSION}
    Extension : ws://127.0.0.1:{cfg['extension_port']}/ws
    Studio    : http://127.0.0.1:{cfg['studio_port']}/api/*
    Keep this window open while you use the AI.
    Press Ctrl+C to stop.
  =============================================
"""
    print(banner, flush=True)

    # ---- HTTP server for the Studio plugin (stdlib thread) ------------------
    studio_port = int(cfg["studio_port"])
    httpd = None
    for attempt in range(2):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", studio_port), StudioHTTPHandler)
            httpd.daemon_threads = True
            break
        except OSError:
            if attempt == 0 and try_reclaim_port(studio_port):
                continue
            log.error("Studio port %d is held by another program. "
                      "Change studio_port in config.json or close the other app.", studio_port)
            sys.exit(2)

    http_thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.5},
                                   name="studio-http", daemon=True)
    http_thread.start()
    log.info("Studio HTTP listening on http://127.0.0.1:%d", studio_port)

    try:
        asyncio.run(main_async(cfg))
    except KeyboardInterrupt:
        pass
    finally:
        log.info("Bridge stopped.")
        try:
            httpd.shutdown()
        except Exception:  # noqa: BLE001
            pass
        try:
            PID_FILE.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    main()
