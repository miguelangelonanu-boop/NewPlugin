/* StudioPilot - core/parser.js
 * PURE string logic, zero DOM - the provider hands us the assistant reply as
 * plain text (code fences normally survive as <pre> textContent, but the
 * backticks/language tags may be mangled or stripped by the site's markdown).
 *
 * Command contract (defined by SPConfig.SYSTEM_PROMPT):
 *   {"commands":[{"action":"get_scripts"}, ...]}   (batch form)
 *   {"action":"read_script","path":"..."}          (single form)
 * Extraction strategy, in order:
 *   1) ``` fences tagged json (or untagged) that parse to a command object;
 *   2) brace-matched JSON objects anywhere in the text containing
 *      "commands" / "action" (covers pages that rendered the fence as <pre>
 *      and dropped the backticks).
 * Also exports the completion-marker check and tool-result formatting.
 */
(function (root) {
  "use strict";

  const COMPLETE_RE = /\bTASK_COMPLETE\b/;
  // A string-valued key that prose almost never contains - the signature we
  // brace-match from when scanning rendered text.
  const SIGNATURE_RE = /"(?:commands|action)"\s*:\s*[{"\[]/;

  // ------------------------------------------------------------------
  // JSON helpers
  // ------------------------------------------------------------------

  // String-aware matching-brace finder: index of the "}" that closes the "{"
  // at `start`, skipping braces inside JSON string literals (escapes handled).
  // Returns -1 if unbalanced.
  function matchBrace(text, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { if (--depth === 0) return i; }
    }
    return -1;
  }

  // JSON.parse with tolerant fallbacks: strip raw control characters inside
  // string literals (models sometimes emit literal tabs/newlines) and drop
  // trailing commas before } or ].
  function parseLoose(raw) {
    try { return { value: JSON.parse(raw) }; } catch (e1) {
      let fixed = escapeBareControlChars(raw).replace(/,\s*([}\]])/g, "$1");
      try { return { value: JSON.parse(fixed) }; } catch (e2) {
        return { error: String((e2 && e2.message) || e2) };
      }
    }
  }

  function escapeBareControlChars(raw) {
    let out = "", inStr = false, esc = false;
    for (const c of raw) {
      if (inStr) {
        if (esc) { out += c; esc = false; continue; }
        if (c === "\\") { out += c; esc = true; continue; }
        if (c === '"') { out += c; inStr = false; continue; }
        if (c === "\n") { out += "\\n"; continue; }
        if (c === "\r") { out += "\\r"; continue; }
        if (c === "\t") { out += "\\t"; continue; }
        out += c;
      } else {
        if (c === '"') inStr = true;
        out += c;
      }
    }
    return out;
  }

  // Normalize a parsed value into an array of command objects, or null.
  function toCommands(value) {
    if (Array.isArray(value)) {
      const out = value.filter((v) => v && typeof v === "object" && typeof v.action === "string");
      return out.length ? out : null;
    }
    if (value && typeof value === "object") {
      if (Array.isArray(value.commands)) {
        const out = value.commands.filter((v) => v && typeof v === "object" && typeof v.action === "string");
        return out.length ? out : null;
      }
      if (typeof value.action === "string") return [value];
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Fence extraction (``` json ... ```  — language tag tolerated loosely,
  // sites sometimes render it as `j s o n` or prepend UI captions)
  // ------------------------------------------------------------------

  // Returns [{raw, start, end, tag}] covering closed fences AND a final
  // unclosed fence (truncated stream) if present.
  function findFences(text) {
    const out = [];
    const re = /```/g;
    let m, openStart = -1, openTag = "";
    while ((m = re.exec(text)) !== null) {
      if (openStart === -1) {
        openStart = m.index;
        // language tag = rest of the line
        const nl = text.indexOf("\n", m.index);
        openTag = (nl === -1 ? text.slice(m.index + 3) : text.slice(m.index + 3, nl)).trim().toLowerCase();
        re.lastIndex = nl === -1 ? text.length : nl;
      } else {
        out.push({ raw: text.slice(openStart, m.index + 3), body: text.slice(openStart, m.index), start: openStart, end: m.index + 3, tag: openTag, closed: true });
        openStart = -1;
      }
    }
    if (openStart !== -1) {
      out.push({ raw: text.slice(openStart), body: text.slice(openStart), start: openStart, end: text.length, tag: openTag, closed: false });
    }
    return out;
  }

  // Strip the leading ``` line of a fence body.
  function fenceInner(fence) {
    const nl = fence.body.indexOf("\n");
    return nl === -1 ? "" : fence.body.slice(nl + 1);
  }

  // Sites bleed code-block chrome ("Copy" captions etc.) into <pre> content.
  // Safe because it requires trailing whitespace + an opening brace/quote:
  // a real Lua/JSON payload never starts with "json " or "Copy " literally.
  function stripChrome(inner) {
    return inner.replace(/^\s*(?:json|lua|luau|copy)\s+(?=[{"])/i, "");
  }

  // ------------------------------------------------------------------
  // Main extraction
  // ------------------------------------------------------------------

  /**
   * extractCommands(text) -> {
   *   commands:      flat array of command objects (in reply order),
   *   looksTruncated: a command-looking block started but never closed,
   *   parseErrors:   descriptions of blocks that LOOKED like commands but failed
   * }
   */
  function extractCommands(text) {
    const result = { commands: [], looksTruncated: false, parseErrors: [] };
    if (!text || typeof text !== "string") return result;
    const consumed = []; // [start, end) ranges already extracted

    // -- pass 1: fenced blocks ------------------------------------------
    for (const fence of findFences(text)) {
      const inner = fenceInner(fence);
      const candidate = stripChrome(inner).trim();
      const isJsonish = candidate.startsWith("{") || candidate.startsWith("[");
      if (!isJsonish) continue; // luau/lua/plain fences are content, not commands
      consumed.push([fence.start, fence.end]);
      const parsed = parseLoose(candidate);
      if (parsed.error) {
        if (!fence.closed || SIGNATURE_RE.test(candidate)) {
          result.parseErrors.push(parsed.error);
          if (!fence.closed) result.looksTruncated = true;
        }
        continue;
      }
      const cmds = toCommands(parsed.value);
      if (!cmds) continue;
      for (const c of cmds) result.commands.push(c);
    }

    // -- pass 2: brace-matched objects anywhere (rendered <pre>, inline) -
    const consumedRangeAt = (pos) => consumed.find(([s, e]) => pos >= s && pos < e) || null;
    let idx = 0;
    while (idx < text.length) {
      const sig = SIGNATURE_RE.exec(text.slice(idx));
      if (!sig) break;
      const sigPos = idx + sig.index;

      // signature inside an already-extracted range? skip past it
      const inside = consumedRangeAt(sigPos);
      if (inside) { idx = inside[1]; continue; }

      // nearest "{" candidates before the signature, nearest first
      let done = false;
      let searchFrom = sigPos;
      for (let hop = 0; hop < 6 && searchFrom >= 0 && !done; hop++) {
        const bracePos = text.lastIndexOf("{", searchFrom);
        if (bracePos === -1) break;
        searchFrom = bracePos - 1;
        const rangeHere = consumedRangeAt(bracePos);
        if (rangeHere) { idx = rangeHere[1]; done = true; break; }
        const close = matchBrace(text, bracePos);
        if (close === -1) continue; // unbalanced here: try an earlier "{"
        const rangeClose = consumedRangeAt(close);
        if (rangeClose) { idx = rangeClose[1]; done = true; break; }
        const parsed = parseLoose(text.slice(bracePos, close + 1));
        if (parsed.error) continue;
        const cmds = toCommands(parsed.value);
        if (!cmds) continue;
        consumed.push([bracePos, close + 1]);
        for (const c of cmds) result.commands.push(c);
        idx = close + 1;
        done = true;
        break;
      }
      if (!done) {
        // signature present but nothing parsed: streaming truncation?
        const open = text.lastIndexOf("{", sigPos);
        if (open !== -1 && !consumedRangeAt(open) && matchBrace(text, open) === -1) {
          result.looksTruncated = true;
        }
        idx = sigPos + sig[0].length;
      }
    }

    return result;
  }

  // ------------------------------------------------------------------
  // Reply helpers for the agent loop
  // ------------------------------------------------------------------

  const hasCompleteMarker = (text) => COMPLETE_RE.test(text || "");
  const hasCommandSignature = (text) => !!text && SIGNATURE_RE.test(text);

  // Truncate a long string keeping head AND tail, marking the gap.
  function truncateHeadTail(str, cap) {
    if (!str || str.length <= cap) return str;
    const marker = `\n[…StudioPilot truncated ${str.length - cap} of ${str.length} characters here…]\n`;
    const budget = cap - marker.length;
    const headLen = Math.floor(budget * 0.85);
    const tailLen = budget - headLen;
    return str.slice(0, headLen) + marker + str.slice(str.length - tailLen);
  }

  /**
   * Build the message sent back to the AI after executing a commands batch.
   * `results` is the bridge's per-command array.
   */
  function formatResults(results, sendCap) {
    const lines = [];
    let okCount = 0;
    for (const r of results) if (r && r.ok !== false) okCount++;
    lines.push(`STUDIOPILOT TOOL RESULTS (${okCount}/${results.length} ok):`);
    results.forEach((r, i) => {
      const tag = r && r.ok !== false ? "ok" : "ERROR";
      const action = (r && r.action) || "?";
      let body;
      try {
        body = JSON.stringify(r, null, 1);
      } catch {
        body = String(r);
      }
      body = truncateHeadTail(body, 60000); // per-command cap before global cap
      lines.push(`\n[${i + 1}] ${action} — ${tag}\n${body}`);
    });
    lines.push(
      "\nIf the user's task is fully done, answer in plain text ending with " +
      "TASK_COMPLETE. Otherwise reply with exactly one ```json commands block " +
      "containing the next actions."
    );
    return truncateHeadTail(lines.join("\n"), sendCap || 100000);
  }

  const SPParser = {
    matchBrace,
    parseLoose,
    toCommands,
    findFences,
    extractCommands,
    hasCompleteMarker,
    hasCommandSignature,
    truncateHeadTail,
    formatResults,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = SPParser;
  root.SPParser = SPParser;
})(typeof window !== "undefined" ? window : globalThis);
