/* StudioPilot - core/main.js
 * The agent loop + injected control bar. Provider-agnostic: it drives the
 * site's chat through window.SPProvider (providers/*.js), parses replies with
 * SPParser and executes commands in Roblox Studio through the local bridge
 * (bridge.py) over a loopback WebSocket.
 */
(function () {
  "use strict";
  if (window.SPMain) return; // content script injected twice?
  const D = window.SPDom;
  const P = window.SPParser;
  const C = window.SPConfig;
  const provider = window.SPProvider;
  if (!D || !P || !C || !provider) return;
  if (!provider.hostMatch(location.hostname)) return;

  const sleep = D.sleep;
  const logLines = [];

  // =====================================================================
  // Bridge client (WebSocket to bridge.py)
  // =====================================================================
  const bridge = {
    ws: null,
    wsConnected: false,
    studioConnected: false,
    plugin: null,
    bridgeVersion: null,
    _pending: new Map(),
    _seq: 0,
    _reconnectTimer: null,

    connect() {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
      let ws;
      try {
        ws = new WebSocket(C.BRIDGE_WS_URL);
      } catch {
        this._scheduleReconnect();
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.wsConnected = true;
        log(`bridge conectada (${C.BRIDGE_WS_URL})`);
        try { ws.send(JSON.stringify({ type: "hello", client: "studiopilot-extension", provider: provider.id, version: C.VERSION })); } catch {}
        try { ws.send(JSON.stringify({ type: "status_request" })); } catch {}
        ui.refresh();
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "status") {
          this.studioConnected = !!msg.studioConnected;
          this.plugin = msg.plugin || null;
          this.bridgeVersion = msg.bridgeVersion || this.bridgeVersion;
          ui.refresh();
        } else if (msg.type === "hello") {
          this.bridgeVersion = msg.version || null;
          ui.refresh();
        } else if (msg.type === "result") {
          const p = this._pending.get(msg.id);
          if (p) {
            this._pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.ok) p.resolve(msg.results || []);
            else p.reject(new Error(msg.error || "unknown bridge error"));
          }
        }
      };
      const drop = () => {
        this.wsConnected = false;
        this.studioConnected = false;
        for (const [, p] of this._pending) {
          clearTimeout(p.timer);
          p.reject(new Error("bridge disconnected"));
        }
        this._pending.clear();
        ui.refresh();
        this._scheduleReconnect();
      };
      ws.onclose = drop;
      ws.onerror = () => { try { ws.close(); } catch {} };
    },

    _scheduleReconnect() {
      if (this._reconnectTimer) return;
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this.connect();
      }, C.WS_RECONNECT_MS);
    },

    execute(commands) {
      return new Promise((resolve, reject) => {
        if (!this.wsConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
          reject(new Error("bridge offline - run start.bat / MacOS_Start.command on your PC"));
          return;
        }
        const id = "sp-" + (++this._seq) + "-" + Date.now();
        const timer = setTimeout(() => {
          this._pending.delete(id);
          reject(new Error("timeout: Studio did not answer in time"));
        }, C.EXECUTE_TIMEOUT_MS);
        this._pending.set(id, { resolve, reject, timer });
        this.ws.send(JSON.stringify({ type: "execute", id, commands }));
      });
    },
  };

  // =====================================================================
  // UI - injected bar (Shadow DOM keeps the site's CSS/mutations out)
  // =====================================================================
  const ui = {};
  function $(sel) { return ui.shadow.querySelector(sel); }

  function log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    logLines.push(`[${t}] ${msg}`);
    if (logLines.length > 200) logLines.shift();
    const el = $("#sp-log");
    if (el) { el.textContent = logLines.join("\n"); el.scrollTop = el.scrollHeight; }
  }

  function buildPanel() {
    const host = document.createElement("div");
    host.id = D.ROOT_ID;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .bar { position: fixed; bottom: 18px; right: 18px; z-index: 2147483646;
         width: 360px; background: #16161c; color: #e8e8ee;
         border: 1px solid #34343f; border-radius: 12px;
         box-shadow: 0 8px 28px rgba(0,0,0,.45);
         font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; }
  .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
          cursor: default; border-bottom: 1px solid #26262e; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #777; flex: none; }
  .dot.g { background: #3ecf6f; } .dot.y { background: #f5b73f; } .dot.r { background: #888; }
  .title { font-weight: 700; font-size: 13px; }
  .tag { font-size: 10px; color: #9a9ab0; border: 1px solid #3a3a48; padding: 0 5px;
         border-radius: 6px; font-weight: 600; }
  .grow { flex: 1; }
  .hbtn { background: #23232c; color: #cfcfe0; border: 1px solid #3a3a48;
          border-radius: 7px; width: 26px; height: 26px; cursor: pointer; font-size: 13px; }
  .hbtn:hover { background: #2c2c38; }
  .body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .hidden { display: none !important; }
  textarea.goal { width: 100%; min-height: 56px; resize: vertical; background: #101015;
    color: #e8e8ee; border: 1px solid #34343f; border-radius: 8px; padding: 7px; font: inherit; }
  .row { display: flex; gap: 8px; }
  button.primary { flex: 1; background: #4f46e5; color: white; border: 0; padding: 8px 10px;
    border-radius: 8px; font-weight: 700; cursor: pointer; font-size: 13px; }
  button.primary:disabled { opacity: .45; cursor: default; }
  button.danger { background: #7f1d2b; color: #ffd6d6; border: 0; padding: 8px 12px;
    border-radius: 8px; cursor: pointer; font-weight: 600; }
  button.ghost { background: #23232c; color: #cfcfe0; border: 1px solid #3a3a48;
    padding: 8px 12px; border-radius: 8px; cursor: pointer; font-weight: 600; }
  .status { font-size: 12px; color: #b9b9cc; min-height: 16px; }
  .status b { color: #e8e8ee; }
  .warn { color: #ff9c9c; font-size: 12px; }
  pre.log { margin: 0; max-height: 160px; overflow: auto; background: #0d0d12;
    border: 1px solid #2a2a33; border-radius: 8px; padding: 6px; font-size: 11px;
    color: #a8e6a3; white-space: pre-wrap; word-break: break-word; }
  .pill { position: fixed; bottom: 18px; right: 18px; z-index: 2147483646;
    background: #16161c; color: #e8e8ee; border: 1px solid #34343f; border-radius: 20px;
    padding: 6px 12px; font: 12px -apple-system, "Segoe UI", Roboto, sans-serif;
    cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
</style>
<div class="bar" id="sp-bar">
  <div class="head">
    <span class="dot r" id="sp-dot"></span>
    <span class="title">StudioPilot</span>
    <span class="tag">${provider.name}</span>
    <span class="tag">v${C.VERSION}</span>
    <span class="grow"></span>
    <button class="hbtn" id="sp-logbtn" title="Log">≡</button>
    <button class="hbtn" id="sp-min" title="Minimizar">–</button>
  </div>
  <div class="body" id="sp-body">
    <div class="warn hidden" id="sp-warn"></div>
    <textarea class="goal" id="sp-goal" placeholder="Descreva o que fazer no Roblox Studio… (ex.: crie um sistema de checkpoint com leaderstats)"></textarea>
    <div class="row">
      <button class="primary" id="sp-start">▶ Iniciar sessão</button>
      <button class="ghost hidden" id="sp-resume">Retomar</button>
      <button class="danger hidden" id="sp-stop">■ Parar</button>
    </div>
    <div class="status" id="sp-status">Iniciando…</div>
    <pre class="log hidden" id="sp-log"></pre>
  </div>
</div>
<div class="pill hidden" id="sp-pill">⚡ StudioPilot</div>`;
    (document.body || document.documentElement).appendChild(host);
    ui.host = host; ui.shadow = shadow;

    $("#sp-min").onclick = () => { $("#sp-bar").classList.add("hidden"); $("#sp-pill").classList.remove("hidden"); };
    $("#sp-pill").onclick = () => { $("#sp-pill").classList.add("hidden"); $("#sp-bar").classList.remove("hidden"); };
    $("#sp-logbtn").onclick = () => $("#sp-log").classList.toggle("hidden");
    $("#sp-start").onclick = () => session.startFromUi();
    $("#sp-stop").onclick = () => session.stop("user");
    $("#sp-resume").onclick = () => session.resume();
  }

  ui.setStatus = (html) => { const el = $("#sp-status"); if (el) el.innerHTML = html; };
  ui.setWarn = (text) => {
    const el = $("#sp-warn"); if (!el) return;
    if (text) { el.textContent = text; el.classList.remove("hidden"); }
    else el.classList.add("hidden");
  };
  ui.refresh = () => {
    const dot = $("#sp-dot");
    if (dot) dot.className = "dot " + (!bridge.wsConnected ? "r" : bridge.studioConnected ? "g" : "y");
    if (!session.active) {
      const bits = [];
      bits.push(!bridge.wsConnected ? "Bridge offline — rode <b>start.bat</b> (Win) ou <b>MacOS_Start.command</b>"
        : bridge.studioConnected
          ? "Bridge + Studio conectados ✅"
          : "Bridge OK · Studio não conectado (abra o Studio e um place)");
      if (bridge.plugin && bridge.plugin.place) bits.push(`place: <b>${escapeHtml(bridge.plugin.place)}</b>`);
      ui.setStatus(bits.join(" · "));
    }
  };
  ui.setRunning = (on) => {
    $("#sp-start").classList.toggle("hidden", on);
    $("#sp-stop").classList.toggle("hidden", !on);
    if (!on) $("#sp-resume").classList.add("hidden");
  };
  ui.showResume = (show) => $("#sp-resume").classList.toggle("hidden", !show);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // =====================================================================
  // Agent session / loop
  // =====================================================================
  const session = {
    active: false,
    _stopRequested: false,
    turns: 0,
    _resumeResolve: null,

    async startFromUi() {
      const goalEl = $("#sp-goal");
      let goal = (goalEl.value || "").trim();
      if (!goal) {
        // fall back to whatever the user already typed in the site's composer
        const ed = provider.getEditor();
        goal = ed ? String(ed.value != null ? ed.value : D.getEditableText(ed)).trim() : "";
      }
      if (!goal) { ui.setWarn("Descreva a tarefa na caixa acima ou no campo de mensagem do chat."); return; }
      ui.setWarn("");
      const warn = provider.modeWarning && provider.modeWarning();
      if (warn) { ui.setWarn(warn); return; }

      this.active = true;
      this._stopRequested = false;
      this.turns = 0;
      ui.setRunning(true);
      try {
        const firstMessage = C.SYSTEM_PROMPT + "\n" + goal;
        await this.sendAndLoop(firstMessage);
      } catch (err) {
        if (String(err && err.message || err) !== "stopped") {
          log("erro: " + (err && err.message || err));
          ui.setStatus("⚠️ " + escapeHtml(err && err.message || String(err)));
        }
      } finally {
        this.active = false;
        ui.setRunning(false);
        ui.refresh();
      }
    },

    stop(reason) {
      this._stopRequested = true;
      const r = this._resumeResolve; this._resumeResolve = null;
      if (r) r();
      log("sessão interrompida (" + reason + ")");
    },

    resume() {
      ui.showResume(false);
      const r = this._resumeResolve; this._resumeResolve = null;
      if (r) r();
    },

    _checkStop() { if (this._stopRequested) throw new Error("stopped"); },

    async sendAndLoop(message) {
      let firstSend = true;
      while (this.turns < C.MAX_TURNS) {
        this._checkStop();
        if (message != null) {
          ui.setStatus(`Enviando ${firstSend ? "pedido" : "resultados"} à IA…`);
          await waitIdle();
          await provider.typeAndSend(message);
          await sleep(400);
        }
        firstSend = false;
        const baseline = provider.readReply() || { id: null, text: null };

        ui.setStatus("Aguardando resposta da IA…");
        const reply = await this.waitForReply(baseline, C.REPLY_TIMEOUT_MS);

        const { commands, looksTruncated } = P.extractCommands(reply);
        if (!commands.length && P.hasCompleteMarker(reply)) {
          ui.setStatus(`✅ Concluído em ${this.turns} turno(s). TASK_COMPLETE recebido.`);
          log("TASK_COMPLETE — sessão encerrada pela IA");
          return;
        }

        if (commands.length) {
          this.turns++;
          log(`turno ${this.turns}: ${commands.length} comando(s) da IA`);
          ui.setStatus(`Executando ${commands.length} comando(s) no Studio… (turno ${this.turns}/${C.MAX_TURNS})`);
          let results = await this.executeWithResume(commands);
          this._checkStop();
          message = P.formatResults(results, C.SEND_CAP);
          continue;
        }

        if (looksTruncated) {
          log("resposta parece truncada — pedindo para continuar");
          message = "Continue exactly where you stopped (keep the same command format).";
          continue;
        }

        // plain-text reply without completion marker: likely the model asked a
        // question or forgot the format. Wait for the user's follow-up message
        // (or a resumed generation) and continue the loop.
        log("resposta sem comandos e sem TASK_COMPLETE — aguardando o usuário");
        ui.setStatus("Aguardando sua mensagem no chat… (ou pressione ■ Parar)");
        await this.waitForReply(provider.readReply() || { id: null, text: null },
                                C.IDLE_USER_TIMEOUT);
        // user replied; let the AI's NEW answer arrive on the next iteration
        message = null;
      }
      ui.setStatus("⚠️ Limite de " + C.MAX_TURNS + " turnos atingido — sessão pausada.");
    },

    // Wait for a NEW assistant reply that stopped changing. "New" = a different
    // reply NODE id than the baseline (normal case), or the same node whose
    // text changed after a generation was seen (sites that reuse the stream
    // container instead of appending a new one).
    async waitForReply(baseline, timeoutMs) {
      const baseId = baseline.id, baseText = baseline.text;
      const t0 = Date.now();
      let lastText = "", lastChange = Date.now(), seenGen = false, sawNew = false;
      while (true) {
        this._checkStop();
        if (document.hidden) await waitVisible(this);
        const gen = provider.isGenerating();
        if (gen) { seenGen = true; lastChange = Date.now(); }
        const r = provider.readReply() || {};
        const isNewNode = r.present && r.id != null && r.id !== baseId;
        const grewSameNode = r.present && r.id != null && r.id === baseId &&
          baseText != null && r.text !== baseText;
        if (isNewNode || (grewSameNode && seenGen)) {
          sawNew = true;
          if (r.text !== lastText) { lastText = r.text || ""; lastChange = Date.now(); }
        }
        const stableFor = Date.now() - lastChange;
        const stableNeed = seenGen ? C.STABLE_AFTER_GEN_MS : C.STABLE_NO_GEN_MS;
        if (sawNew && !gen && lastText && stableFor > stableNeed) {
          // never finalize a command block that is still open (mid-stream cut)
          if (!P.extractCommands(lastText).looksTruncated || stableFor > stableNeed * 3) {
            return lastText;
          }
        }
        if (Date.now() - t0 > timeoutMs) throw new Error("timeout aguardando resposta da IA");
        await sleep(C.POLL_MS);
      }
    },

    // Execute a batch; if the bridge/Studio fails, pause with a Resume button
    // (the user fixes Studio and clicks Retomar — same commands retry).
    async executeWithResume(commands) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        this._checkStop();
        try {
          return await bridge.execute(commands);
        } catch (err) {
          const msg = err && err.message || String(err);
          log("falha na execução: " + msg);
          ui.setStatus("⚠️ " + escapeHtml(msg) + " — corrija e clique <b>Retomar</b>.");
          ui.showResume(true);
          await new Promise((res) => { this._resumeResolve = res; });
          this._checkStop();
          ui.setStatus("Reexecutando comandos…");
        }
      }
    },
  };

  // Wait until the site's composer is not generating (before we type).
  async function waitIdle() {
    const t0 = Date.now();
    while (provider.isGenerating()) {
      if (Date.now() - t0 > 120000) throw new Error("o chat está ocupado gerando outra resposta");
      await sleep(400);
    }
  }

  // Pause the whole loop while the AI tab is backgrounded/minimized: running
  // blind is how duplicate/ghost tool calls happen.
  function waitVisible(sess) {
    return new Promise((resolve) => {
      (function poll() {
        if (!document.hidden) return resolve();
        sess._checkStop();
        setTimeout(poll, 800);
      })();
    });
  }

  // Arena-only: surface route/mode problems on the bar.
  async function modeGuard() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (provider.modeWarning) {
        const w = provider.modeWarning() || "";
        if (!session.active) ui.setWarn(w);
      }
      await sleep(3000);
    }
  }

  // =====================================================================
  function boot() {
    if (!document.body) return setTimeout(boot, 250);
    buildPanel();
    bridge.connect();
    modeGuard();
    log(`provider detectado: ${provider.name} (${location.host}${location.pathname})`);
    ui.refresh();
  }
  boot();
  window.SPMain = { bridge, session, ui };
})();
