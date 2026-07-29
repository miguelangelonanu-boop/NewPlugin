/* StudioPilot - providers/chatgpt.js
 * ChatGPT (chatgpt.com / chat.openai.com) site driver. Exposes window.SPProvider.
 *
 * DOM notes:
 *  - Composer: `#prompt-textarea`, a ProseMirror contenteditable div in the
 *    current UI (historically a <textarea> with the same id - both handled).
 *  - Send: `button[data-testid="send-button"]`; while streaming it is replaced
 *    by `button[data-testid="stop-button"]` ("Stop streaming").
 *  - Turns: `article[data-testid^="conversation-turn"]` holding an element with
 *    [data-message-author-role="assistant"|"user"]; the rendered markdown body
 *    is `.markdown`. Code fences render as <pre>, JSON survives textContent.
 */
(function (root) {
  "use strict";
  const D = root.SPDom;
  const nodeId = D.makeNodeIds();

  function getEditor() {
    const byId = document.getElementById("prompt-textarea");
    if (byId && D.visible(byId) && !D.inOurs(byId)) return byId;
    // fallbacks (logged-out onboarding, A/B layouts)
    const candidates = [
      ...document.querySelectorAll('div.ProseMirror[contenteditable="true"]'),
      ...document.querySelectorAll("main textarea"),
      ...document.querySelectorAll('[contenteditable="true"]'),
    ];
    for (const el of candidates) {
      if (D.visible(el) && !D.inOurs(el)) return el;
    }
    return null;
  }

  function sendButton() {
    const b = document.querySelector('button[data-testid="send-button"]');
    if (b && D.visible(b)) return b;
    return D.findButton(/send|enviar|senden/i, { scope: composerScope() });
  }

  function stopButton() {
    const b = document.querySelector('button[data-testid="stop-button"], button[data-testid="composer-stop-button"]');
    if (b && D.visible(b)) return b;
    return D.findButton(/stop( streaming)?|parar/i, { scope: composerScope() });
  }

  function composerScope() {
    const ed = getEditor();
    if (!ed) return document;
    return ed.closest("form") ||
      (ed.parentElement && ed.parentElement.parentElement && ed.parentElement.parentElement.parentElement) ||
      document;
  }

  function assistantTurns() {
    const roles = document.querySelectorAll('[data-message-author-role="assistant"]');
    const out = [];
    for (const r of roles) {
      if (D.inOurs(r)) continue;
      out.push(r.closest("article") || r);
    }
    if (out.length) return out;
    // fallback: markdown bodies not inside our UI
    const md = [...document.querySelectorAll("main .markdown")].filter((el) => !D.inOurs(el));
    return md;
  }

  function textOf(turn) {
    const md = turn.querySelector && turn.querySelector(".markdown");
    return ((md || turn).textContent || "").trim();
  }

  function readReply() {
    const turns = assistantTurns();
    const last = turns.length ? turns[turns.length - 1] : null;
    if (!last) return { present: false, id: null, text: "" };
    return { present: true, id: nodeId(last), text: textOf(last) };
  }

  function isGenerating() {
    return !!stopButton();
  }

  async function typeAndSend(text) {
    const editor = getEditor();
    if (!editor) throw new Error("ChatGPT input box not found (is the chat loaded?)");
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
    else if (editor.tagName === "TEXTAREA") {
      // textarea-era composer submits on Enter
      D.pressEnter(editor);
    } else {
      throw new Error("ChatGPT send button stayed disabled");
    }
  }

  root.SPProvider = {
    id: "chatgpt",
    name: "ChatGPT",
    hostMatch: (h) => /(^|\.)chatgpt\.com$/.test(h) || /(^|\.)chat\.openai\.com$/.test(h),
    getEditor,
    readReply,
    isGenerating,
    typeAndSend,
    modeWarning: () => "",
  };
})(typeof window !== "undefined" ? window : globalThis);
