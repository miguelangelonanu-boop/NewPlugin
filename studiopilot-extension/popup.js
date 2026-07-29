/* StudioPilot - popup: bridge/studio health at a glance. */
"use strict";

const dot = document.getElementById("dot");
const statusEl = document.getElementById("status");

function paint(state) {
  if (!state.bridge) {
    dot.style.background = "#888";
    statusEl.innerHTML = "Bridge <b>offline</b>.<br>Run <b>start.bat</b> (Windows) or " +
      "<b>MacOS_Start.command</b> (macOS/Linux) from the StudioPilot folder.";
    return;
  }
  if (state.studio) {
    dot.style.background = "#3ecf6f";
    const place = state.place ? ` · place <b>${state.place}</b>` : "";
    statusEl.innerHTML = `Bridge <b>online</b> (v${state.version || "?"}) · Studio <b>connected</b>${place}. ✅`;
  } else {
    dot.style.background = "#f5b73f";
    statusEl.innerHTML = `Bridge <b>online</b> · Studio <b>not connected</b>.<br>` +
      "Open Roblox Studio, load a place and make sure the StudioPilot plugin is ON.";
  }
}

chrome.runtime.sendMessage({ type: "bridge_status" }, (res) => {
  if (chrome.runtime.lastError || !res || !res.ok || !res.data) {
    paint({ bridge: false });
    return;
  }
  paint({
    bridge: true,
    studio: !!res.data.studioConnected,
    version: res.data.version,
    place: res.data.plugin && res.data.plugin.place,
  });
});
