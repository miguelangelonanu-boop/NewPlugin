/* StudioPilot - providers/arena.js
 * Arena (arena.ai) site driver - supports BOTH layouts:
 *  - "Direct" chat (/text/*): <textarea> in the only <form>, messages in an
 *    <ol class="...flex-col-reverse"> (DOM newest-first), assistant bodies .prose
 *  - "Agent" mode (/agent*): TipTap/ProseMirror contenteditable composer with
 *    no <form> and no <ol>; messages are detected generically (last visible
 *    markdown container that is not inside the composer).
 */
(function (root) {
  "use strict";
  const D = root.SPDom;
  const nodeId = D.makeNodeIds();

  const SEND_RE = /send( message)?|envoyer|enviar/i;
  const STOP_RE = /stop( generation)?|arr[êe]ter|parar|cancel/i;

  const isAgentRoute = () => /^\/agent/.test(location.pathname);

  // ------------------------------------------------------------------
  // Composer
  // ------------------------------------------------------------------
  function getEditor() {
    // Direct: the ONLY <textarea> inside a <form> (others are recaptcha/hidden)
    for (const el of document.querySelectorAll("form textarea")) {
      if (!D.inOurs(el) && D.visible(el)) return el;
    }
    // Agent: TipTap/ProseMirror contenteditable (no form wrapper)
    for (const el of document.querySelectorAll('.ProseMirror[contenteditable="true"], [contenteditable="true"]')) {
      if (!D.inOurs(el) && D.visible(el)) return el;
    }
    return null;
  }

  function composerScope() {
    const ed = getEditor();
    if (!ed) return document;
    return ed.closest("form") ||
      (function up(n, k) { while (k-- > 0 && n.parentElement) n = n.parentElement; return n; })(ed, 3) ||
      document;
  }

  const sendButton = () => D.findButton(SEND_RE, { scope: composerScope() }) || D.findButton(SEND_RE);
  const stopButton = () => D.findButton(STOP_RE, { scope: composerScope() }) || D.findButton(STOP_RE);

  // ------------------------------------------------------------------
  // Message reading
  // ------------------------------------------------------------------
  function listEl() {
    return document.querySelector("ol.flex-col-reverse") ||
      [...document.querySelectorAll("ol")].find((o) => o.querySelector(".prose")) || null;
  }

  function directAssistantTurns() {
    const ol = listEl();
    if (!ol) return [];
    // DOM is newest-first; reverse to chronological. A turn = direct child
    // carrying mx-auto with a .prose body; user turns are right-aligned.
    return [...ol.children]
      .filter((c) => c.classList.contains("mx-auto") && c.querySelector(".prose"))
      .reverse()
      .filter((c) => !/justify-end/.test(c.className));
  }

  const GENERIC_MSG_SEL =
    ".prose, [class*='markdown-body'], [class*='markdown'], article, " +
    "[data-testid*='assistant'], [class*='assistant-message'], [class*='ChatMessage']";

  function genericCandidates() {
    const seen = [];
    for (const el of document.querySelectorAll(GENERIC_MSG_SEL)) {
      if (D.inOurs(el) || !D.visible(el)) continue;
      if (el.closest("header, nav, aside, footer, form, [contenteditable='true']")) continue;
      // skip elements nested inside an already-accepted candidate
      if (seen.some((outer) => outer.contains(el))) continue;
      seen.push(el);
    }
    return seen;
  }

  function readReply() {
    if (!isAgentRoute()) {
      const turns = directAssistantTurns();
      const last = turns.length ? turns[turns.length - 1] : null;
      if (last) {
        const prose = last.querySelector(".prose");
        return { present: true, id: nodeId(last), text: ((prose || last).textContent || "").trim() };
      }
      // fall through to generic (e.g. direct route mid-reskin)
    }
    const cands = genericCandidates();
    const last = cands.length ? cands[cands.length - 1] : null;
    if (!last) return { present: false, id: null, text: "" };
    return { present: true, id: nodeId(last), text: (last.textContent || "").trim() };
  }

  function isGenerating() {
    if (stopButton()) return true;
    const ed = getEditor();
    if (ed && (ed.getAttribute("aria-disabled") === "true")) return true;
    for (const sel of ["[aria-busy='true']", "[data-loading='true']"]) {
      for (const el of document.querySelectorAll(sel)) {
        if (!D.inOurs(el) && D.visible(el)) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------
  async function typeAndSend(text) {
    const editor = getEditor();
    if (!editor) throw new Error("Arena input box not found (open a chat on arena.ai)");
    editor.focus();
    D.setValue(editor, text.slice(0, root.SPConfig.SEND_CAP));
    let btn = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      btn = sendButton();
      if (D.enabled(btn)) break;
      await D.sleep(150);
    }
    if (D.enabled(btn)) btn.click();
    else D.pressEnter(editor); // TipTap/textarea submits on Enter
  }

  // Warn on routes/modes that don't produce a normal text reply. /agent is
  // supported; Battle/Side-by-Side (A/B) and Code/Search/Image are not.
  function modeWarning() {
    if (/^\/(code|image|search)\//.test(location.pathname)) {
      return "StudioPilot works in plain chat or Agent mode - leave Code / Image / Search routes.";
    }
    for (const c of document.querySelectorAll('button[role="combobox"]')) {
      if (!D.visible(c)) continue;
      const m = (c.textContent || "").toLowerCase().match(/\b(battle|side by side)\b/);
      if (m) return `Arena mode "${m[1]}" replies with A/B comparisons - switch to Direct or Agent mode.`;
    }
    return "";
  }

  root.SPProvider = {
    id: "arena",
    name: "Arena",
    hostMatch: (h) => /(^|\.)arena\.ai$/.test(h),
    isAgentRoute,
    getEditor,
    readReply,
    isGenerating,
    typeAndSend,
    modeWarning,
  };
})(typeof window !== "undefined" ? window : globalThis);
