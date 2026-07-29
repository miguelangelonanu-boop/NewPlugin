/* StudioPilot - providers/claude.js
 * Claude (claude.ai) site driver. Exposes window.SPProvider.
 *
 * DOM notes (claude.ai, validated structure as of 2026 + layered fallbacks):
 *  - Composer: a TipTap/ProseMirror `div[contenteditable="true"].ProseMirror`
 *    inside the input fieldset. Placeholder lives on an empty <p>.
 *  - Send: a button whose aria-label reads "Send message" (fr/en/pt variants);
 *    during generation it becomes a stop button.
 *  - Assistant turns: `.font-claude-message` wrappers; streaming turns expose
 *    `data-is-streaming="true"` on an ancestor. Code fences render as real
 *    <pre> blocks, so JSON survives in textContent for SPParser.
 */
(function (root) {
  "use strict";
  const D = root.SPDom;
  const nodeId = D.makeNodeIds();

  const SEND_RE = /send( message)?|envoyer|enviar|senden/i;
  const STOP_RE = /stop|pause|arr[êe]ter|parar|anhalten/i;

  // ------------------------------------------------------------------
  function getEditor() {
    const candidates = [
      ...document.querySelectorAll('div.ProseMirror[contenteditable="true"]'),
      ...document.querySelectorAll('[contenteditable="true"][data-placeholder]'),
      ...document.querySelectorAll('[contenteditable="true"]'),
    ];
    for (const el of candidates) {
      if (!D.visible(el) || D.inOurs(el)) continue;
      if (el.closest("main") || el.closest("form") || el.closest("fieldset") || candidates.length === 1) return el;
    }
    return D.visible(candidates[0]) && !D.inOurs(candidates[0]) ? candidates[0] : null;
  }

  function composerScope() {
    const ed = getEditor();
    if (!ed) return document;
    return ed.closest("fieldset") || ed.closest("form") ||
      ed.parentElement && ed.parentElement.parentElement || document;
  }

  function sendButton() {
    const scope = composerScope();
    let b = D.findButton(SEND_RE, { scope });
    if (b) return b;
    return D.findButton(SEND_RE); // page-wide fallback
  }

  function stopButton() {
    return D.findButton(STOP_RE, { scope: composerScope() }) || D.findButton(STOP_RE);
  }

  // ------------------------------------------------------------------
  function assistantBlocks() {
    const blocks = [];
    for (const el of document.querySelectorAll(".font-claude-message")) {
      if (!D.inOurs(el)) blocks.push(el);
    }
    if (blocks.length) return blocks;
    // fallback: any markdown-looking block inside a message region
    for (const el of document.querySelectorAll(".standard-markdown, [data-testid*='assistant'] .markdown, main .prose")) {
      if (!D.inOurs(el)) blocks.push(el);
    }
    return blocks;
  }

  function readReply() {
    const blocks = assistantBlocks();
    const last = blocks.length ? blocks[blocks.length - 1] : null;
    if (!last) return { present: false, id: null, text: "" };
    const holder = last.closest("[data-is-streaming]") || last;
    return { present: true, id: nodeId(holder), text: (last.textContent || "").trim() };
  }

  function isGenerating() {
    if (stopButton()) return true;
    for (const el of document.querySelectorAll("[data-is-streaming]")) {
      if (el.getAttribute("data-is-streaming") === "true") return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  async function typeAndSend(text) {
    const editor = getEditor();
    if (!editor) throw new Error("Claude input box not found (is the chat loaded?)");
    editor.focus();
    D.setValue(editor, text.slice(0, root.SPConfig.SEND_CAP));
    // wait for Claude to enable the send button (it reacts to the input event)
    let btn = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      btn = sendButton();
      if (D.enabled(btn)) break;
      await D.sleep(150);
    }
    if (D.enabled(btn)) {
      btn.click();
    } else {
      D.pressEnter(editor); // TipTap submits on Enter (no shift)
    }
  }

  root.SPProvider = {
    id: "claude",
    name: "Claude",
    hostMatch: (h) => /(^|\.)claude\.ai$/.test(h),
    getEditor,
    readReply,
    isGenerating,
    typeAndSend,
    modeWarning: () => "",
  };
})(typeof window !== "undefined" ? window : globalThis);
