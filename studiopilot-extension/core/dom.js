/* StudioPilot - core/dom.js
 * Small DOM helpers shared by the provider modules.
 * Each AI site renders its composer differently (React textarea, ProseMirror,
 * TipTap...); these helpers abstract "set text + submit" across them.
 */
(function (root) {
  "use strict";

  const ROOT_ID = "sp-root"; // our own injected UI - never treat as page content

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function inOurs(el) {
    return !!(el && el.closest && el.closest("#" + ROOT_ID));
  }

  function visible(el) {
    if (!el || inOurs(el)) return false;
    let n = el;
    while (n && n !== document.documentElement) {
      if (n.nodeType === 1) {
        const cs = n.style || {};
        // cheap checks only - getComputedStyle on whole tree is costly
        if (cs.display === "none" || cs.visibility === "hidden") return false;
      }
      n = n.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  // React-controlled <textarea>: set .value via the native prototype setter so
  // React's onChange fires, then dispatch an input event.
  function setTextareaValue(el, value) {
    const proto = el.ownerDocument.defaultView.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ProseMirror / TipTap contenteditable: focus, select existing content, then
  // insertText so the editor framework observes a real input (beforeinput) and
  // updates its internal document.
  function setEditableValue(el, text) {
    el.focus();
    const doc = el.ownerDocument;
    const sel = doc.defaultView.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    // execCommand is deprecated but remains the most reliable cross-framework
    // way to feed text into ProseMirror/TipTap from an extension.
    doc.execCommand("insertText", false, text);
    if (getEditableText(el) === "") {
      // last resort for very custom editors
      el.innerText = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  }

  function getEditableText(el) {
    return (el.innerText != null ? el.innerText : el.textContent) || "";
  }

  function setValue(el, text) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") setTextareaValue(el, text);
    else setEditableValue(el, text);
  }

  function pressEnter(el) {
    const opts = { key: "Enter", code: "Enter", which: 13, keyCode: 13, bubbles: true, cancelable: true, composed: true };
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, opts));
    }
  }

  // Find an on-screen button whose aria-label (or text) matches a regex.
  function findButton(ariaRe, opts) {
    const scope = (opts && opts.scope) || document;
    for (const b of scope.querySelectorAll("button")) {
      if (!visible(b)) continue;
      const aria = b.getAttribute("aria-label") || "";
      const testid = b.getAttribute("data-testid") || "";
      const txt = (b.textContent || "").trim();
      if (ariaRe.test(aria) || ariaRe.test(testid) || ariaRe.test(txt)) return b;
    }
    return null;
  }

  function enabled(btn) {
    return !!btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
  }

  // Monotonic id per DOM node (stable per node, new id for a new reply node).
  function makeNodeIds() {
    const map = new WeakMap();
    let seq = 0;
    return (node) => {
      if (!node) return null;
      let id = map.get(node);
      if (!id) { id = ++seq; map.set(node, id); }
      return id;
    };
  }

  root.SPDom = {
    ROOT_ID, sleep, visible, inOurs,
    setTextareaValue, setEditableValue, setValue, getEditableText,
    pressEnter, findButton, enabled, makeNodeIds,
  };
})(typeof window !== "undefined" ? window : globalThis);
