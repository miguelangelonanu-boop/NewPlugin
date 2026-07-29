#!/usr/bin/env python3
"""
StudioPilot end-to-end test.

Spins up the REAL bridge (bridge.py) on test ports, attaches:
  - a FAKE Roblox Studio plugin (HTTP long-poll client, in-memory game state)
  - a FAKE browser extension (WebSocket client)
and drives the exact protocol the extension and plugin use, asserting the whole
round trip: status flips, command execution, error paths, timeouts.

Run:  python tests/test_e2e.py
(requires the `websockets` package - the same one the bridge needs)
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
EXT_PORT = 27654
STUDIO_PORT = 27655
WS_URL = f"ws://127.0.0.1:{EXT_PORT}/ws"
HTTP_BASE = f"http://127.0.0.1:{STUDIO_PORT}"

try:
    from websockets.asyncio.client import connect as ws_connect
except ImportError:  # very old websockets
    from websockets import connect as ws_connect  # type: ignore


# ---------------------------------------------------------------------------
# Fake Studio plugin: in-memory "game" with the same command handlers
# ---------------------------------------------------------------------------

class FakeStudio:
    def __init__(self):
        self.scripts = {
            "game.ServerScriptService.Main": {
                "className": "Script",
                "source": "print('hello from Main')",
            }
        }
        self.running = threading.Event()
        self.jobs_seen = 0
        self.thread: threading.Thread | None = None

    # -- command handlers ----------------------------------------------------
    def handle(self, cmd: dict) -> dict:
        a = cmd.get("action")
        if a == "ping":
            return {"action": a, "ok": True, "pong": True, "placeName": "FakePlate"}
        if a == "get_scripts":
            scripts = [{"path": p, "className": s["className"]} for p, s in sorted(self.scripts.items())]
            return {"action": a, "ok": True, "count": len(scripts), "scripts": scripts}
        if a == "read_script":
            s = self.scripts.get(cmd.get("path"))
            if not s:
                return {"action": a, "ok": False, "error": "not found"}
            return {"action": a, "ok": True, "path": cmd["path"], "source": s["source"], "className": s["className"]}
        if a in ("set_script", "create_script"):
            path, src = cmd.get("path"), cmd.get("source")
            if not path or not isinstance(src, str):
                return {"action": a, "ok": False, "error": "bad params"}
            created = path not in self.scripts
            self.scripts[path] = {"className": cmd.get("className", "Script"), "source": src}
            return {"action": a, "ok": True, "path": path, "action_": "created" if created else "updated", "length": len(src)}
        if a == "delete_script":
            path = cmd.get("path")
            if path not in self.scripts:
                return {"action": a, "ok": False, "error": "not found"}
            del self.scripts[path]
            return {"action": a, "ok": True, "deleted": path}
        if a == "run_code":
            code = cmd.get("code", "")
            if "error(" in code:
                return {"action": a, "ok": False, "error": "simulated luau error"}
            return {"action": a, "ok": True, "output": "ran: " + code[:40], "durationMs": 1}
        if a == "get_tree":
            return {"action": a, "ok": True, "tree": "game (DataModel)\n  Workspace\n  ServerScriptService", "lines": 3}
        return {"action": a, "ok": False, "error": f"unknown action '{a}'"}

    # -- HTTP long-poll loop (exactly what StudioPilot.lua does) --------------
    def _poll_loop(self):
        while self.running.is_set():
            try:
                req = urllib.request.Request(f"{HTTP_BASE}/api/poll?wait=2&place=FakePlate&pluginVersion=test")
                with urllib.request.urlopen(req, timeout=5) as resp:
                    body = json.loads(resp.read().decode())
            except Exception:
                time.sleep(0.2)
                continue
            if not self.running.is_set():
                break
            if body.get("commands"):
                self.jobs_seen += 1
                results = [self.handle(c) for c in body["commands"]]
                data = json.dumps({"id": body["id"], "results": results}).encode()
                try:
                    req = urllib.request.Request(
                        f"{HTTP_BASE}/api/result", data=data,
                        headers={"Content-Type": "application/json"}, method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        resp.read()
                except Exception:
                    pass

    def start(self):
        self.running.set()
        self.thread = threading.Thread(target=self._poll_loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.running.clear()
        if self.thread:
            self.thread.join(timeout=7)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def http_get_json(path: str, timeout: float = 5):
    with urllib.request.urlopen(f"{HTTP_BASE}{path}", timeout=timeout) as resp:
        return json.loads(resp.read().decode())


async def recv_of_type(ws, types, timeout=8):
    deadline = time.time() + timeout
    while time.time() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.time()))
        msg = json.loads(raw)
        if msg.get("type") in types:
            return msg
    raise AssertionError(f"never received message of type {types}")


class BridgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proc = subprocess.Popen(
            [
                sys.executable, str(REPO / "bridge.py"),
                f"--extension-port={EXT_PORT}",
                f"--studio-port={STUDIO_PORT}",
                "--studio-offline-after-s=3",
                "--job-timeout-s=2",
            ],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        # wait for the HTTP side to come up
        for _ in range(60):
            try:
                http_get_json("/api/status", timeout=1)
                return
            except Exception:
                if cls.proc.poll() is not None:
                    out = cls.proc.stdout.read() if cls.proc.stdout else ""
                    raise RuntimeError("bridge exited early:\n" + out)
                time.sleep(0.25)
        raise RuntimeError("bridge did not start")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            cls.proc.kill()

    # ------------------------------------------------------------------
    def test_01_http_status_and_idle_poll(self):
        st = http_get_json("/api/status")
        self.assertTrue(st["ok"])
        self.assertEqual(st["name"], "studiopilot-bridge")
        self.assertFalse(st["studioConnected"], "no studio yet")
        # long-poll with no job returns commands:null after the wait
        t0 = time.time()
        st = http_get_json("/api/poll?wait=1", timeout=5)
        self.assertIsNone(st["commands"])
        self.assertGreaterEqual(time.time() - t0, 0.9, "long-poll should hold ~wait seconds")

    def test_02_full_round_trip(self):
        asyncio.run(self._round_trip())

    async def _round_trip(self):
        studio = FakeStudio()
        async with ws_connect(WS_URL) as ws:
            hello = await recv_of_type(ws, {"hello"})
            self.assertEqual(hello["bridge"], "studiopilot")

            # wait for any liveness from a previous test's poll to expire
            deadline = time.time() + 8
            status = await recv_of_type(ws, {"status"})
            while status["studioConnected"]:
                if time.time() > deadline:
                    self.fail("studio liveness never expired before the test")
                await asyncio.sleep(0.3)
                await ws.send(json.dumps({"type": "status_request"}))
                status = await recv_of_type(ws, {"status"})
            self.assertFalse(status["studioConnected"])

            # studio plugin comes online -> status push flips to connected
            studio.start()
            try:
                status = await recv_of_type(ws, {"status"}, timeout=10)
                while not status["studioConnected"]:
                    status = await recv_of_type(ws, {"status"}, timeout=10)
                self.assertEqual(status["plugin"].get("place"), "FakePlate")

                # ---- execute a full batch, incl. write-then-read and errors --
                await ws.send(json.dumps({
                    "type": "execute", "id": "t1",
                    "commands": [
                        {"action": "ping"},
                        {"action": "get_scripts"},
                        {"action": "set_script", "path": "game.ServerScriptService.Checkpoints",
                         "source": "print('checkpoint system online')"},
                        {"action": "read_script", "path": "game.ServerScriptService.Checkpoints"},
                        {"action": "run_code", "code": "print(workspace)"},
                        {"action": "run_code", "code": "error('boom')"},
                        {"action": "get_tree", "maxDepth": 2},
                        {"action": "totally_made_up"},
                    ],
                }))
                res = await recv_of_type(ws, {"result"}, timeout=15)
                self.assertEqual(res["id"], "t1")
                self.assertTrue(res["ok"])
                results = res["results"]
                self.assertEqual(len(results), 8)

                self.assertTrue(results[0]["pong"])
                self.assertEqual(results[1]["count"], 1)
                self.assertTrue(results[2]["ok"])
                self.assertEqual(results[3]["source"], "print('checkpoint system online')")
                self.assertTrue(results[4]["ok"])
                self.assertFalse(results[5]["ok"], "luau error must surface as ok=false")
                self.assertIn("Workspace", results[6]["tree"])
                self.assertFalse(results[7]["ok"])
                self.assertIn("unknown action", results[7]["error"])

                # ---- validation error is answered immediately ----------------
                await ws.send(json.dumps({"type": "execute", "id": "t2",
                                          "commands": [{"action": "read_script"}]}))
                res = await recv_of_type(ws, {"result"})
                self.assertFalse(res["ok"])
                self.assertIn("missing", res["error"])
            finally:
                # stop the studio loop so the job-timeout test below is not raced
                # by the fake studio answering the job itself
                studio.stop()

            # ---- job timeout: bridge still thinks studio is connected (3s grace),
            # but the only poller is our grabber, which never posts a result ----
            grabber = threading.Thread(
                target=lambda: http_get_json("/api/poll?wait=2", timeout=5), daemon=True)
            grabber.start()
            await ws.send(json.dumps({"type": "execute", "id": "t3",
                                      "commands": [{"action": "ping"}]}))
            res = await recv_of_type(ws, {"result"}, timeout=15)
            self.assertFalse(res["ok"])
            self.assertIn("timeout", res["error"].lower())
            grabber.join(timeout=5)

            # ---- offline detection + fast failure ----------------------------
            deadline = time.time() + 8
            offline_status = None
            while time.time() < deadline:
                await ws.send(json.dumps({"type": "status_request"}))
                offline_status = await recv_of_type(ws, {"status"})
                if not offline_status["studioConnected"]:
                    break
                await asyncio.sleep(0.3)
            self.assertFalse(offline_status["studioConnected"], "studio should look offline")

            jobs_before = studio.jobs_seen
            await ws.send(json.dumps({"type": "execute", "id": "t4",
                                      "commands": [{"action": "ping"}]}))
            res = await recv_of_type(ws, {"result"})
            self.assertFalse(res["ok"])
            self.assertIn("studio_offline", res["error"])
            self.assertEqual(studio.jobs_seen, jobs_before, "offline studio must not receive jobs")


if __name__ == "__main__":
    unittest.main(verbosity=2)
