/* StudioPilot parser tests - run: node tests/test_parser.mjs
 * Pure string logic checks for core/parser.js (no DOM needed).
 */
import "../studiopilot-extension/core/config.js";
import "../studiopilot-extension/core/parser.js";

const P = globalThis.SPParser;
const C = globalThis.SPConfig;

let passed = 0, failed = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log("ok  -", name); }
  else { failed++; console.error("FAIL -", name, "\n  expected:", e, "\n  actual:  ", a); }
}
function ok(cond, name) { eq(!!cond, true, name); }

// 1. classic fenced batch -------------------------------------------------
{
  const text = 'Vou ler os scripts.\n```json\n{"commands":[{"action":"get_scripts"},{"action":"read_script","path":"game.ServerScriptService.Main"}]}\n```';
  const r = P.extractCommands(text);
  eq(r.commands.map((c) => c.action), ["get_scripts", "read_script"], "fenced batch extracts 2 commands");
  ok(!r.looksTruncated, "closed fence is not truncated");
}

// 2. single-action object form -------------------------------------------
{
  const r = P.extractCommands('```json\n{"action":"ping"}\n```');
  eq(r.commands.length, 1, "single action form");
  eq(r.commands[0].action, "ping", "single action name");
}

// 3. rendered page: backticks gone (message textContent from <pre>) ------
{
  const text = 'Comandos:\n{"commands":[{"action":"run_code","code":"print(42)"}]}\npronto';
  const r = P.extractCommands(text);
  eq(r.commands.length, 1, "bare JSON object found without fences");
  eq(r.commands[0].code, "print(42)", "bare JSON payload intact");
}

// 4. lua fences are content, never commands --------------------------------
{
  const r = P.extractCommands('```lua\nprint("hello")\n```\n```luau\ngame.Workspace\n```');
  eq(r.commands.length, 0, "lua/luau fences ignored");
}

// 5. braces inside JSON string values must not confuse brace matching -----
{
  const code = 'if x then print("} { ]") end';
  const payload = JSON.stringify({ commands: [{ action: "run_code", code }] });
  const r = P.extractCommands("```json\n" + payload + "\n```");
  eq(r.commands.length, 1, "string braces safe");
  eq(r.commands[0].code, code, "code with braces survives exactly");
}

// 6. raw newline inside a string (invalid strict JSON) → tolerant fallback -
{
  const text = '```json\n{"commands":[{"action":"set_script","path":"game.ServerScriptService.A","source":"line1\nline2"}]}\n```';
  const r = P.extractCommands(text);
  eq(r.commands.length, 1, "raw-newline JSON recovered");
  eq(r.commands[0].source, "line1\nline2", "newline preserved");
}

// 7. truncated block (stream cut) ------------------------------------------
{
  const open = P.extractCommands('```json\n{"commands":[{"action":"read_script","path":"game.');
  ok(open.looksTruncated, "unclosed fence with commands = truncated");
  const closedButPartial = P.extractCommands('{"commands":[{"action":"get_tree"'); // no fence, no close
  ok(closedButPartial.looksTruncated, "unfenced unclosed object = truncated");
  const plain = P.extractCommands("sure, let me explain first...");
  ok(!plain.looksTruncated, "plain text is not truncated");
}

// 8. multiple command blocks merge in order --------------------------------
{
  const text = '```json\n{"action":"ping"}\n```\ne depois:\n```json\n{"commands":[{"action":"get_selection"},{"action":"get_tree","maxDepth":2}]}\n```';
  const r = P.extractCommands(text);
  eq(r.commands.map((c) => c.action), ["ping", "get_selection", "get_tree"], "multi-block order preserved");
}

// 9. no double counting: fenced JSON must not be re-found by brace scan ----
{
  const text = '```json\n{"commands":[{"action":"ping"}]}\n``` rest of reply';
  const r = P.extractCommands(text);
  eq(r.commands.length, 1, "no duplicates from brace-scan pass");
}

// 10. array-of-actions form -------------------------------------------------
{
  const r = P.extractCommands('```json\n[{"action":"ping"},{"action":"get_scripts"}]\n```');
  eq(r.commands.length, 2, "bare array form");
}

// 11. completion marker ------------------------------------------------------
ok(P.hasCompleteMarker("Tudo pronto! TASK_COMPLETE"), "completion marker detected");
ok(!P.hasCompleteMarker("vou completar agora"), "no false marker");

// 12. formatResults: shape + truncation --------------------------------------
{
  const msg = P.formatResults([
    { action: "ping", ok: true, pong: true },
    { action: "read_script", ok: false, error: "nope" },
  ], 100000);
  ok(msg.includes("STUDIOPILOT TOOL RESULTS"), "results header present");
  ok(msg.includes("1/2 ok"), "ok count shown");
  ok(msg.includes("TASK_COMPLETE"), "closing instruction present");

  const big = "x".repeat(200000);
  const t = P.formatResults([{ action: "read_script", ok: true, source: big }], 100000);
  ok(t.length <= 100000, "oversized result truncated under cap");
  ok(t.includes("truncated"), "truncation marked");
  ok(t.endsWith(t.slice(-20)) && t.indexOf("xxxxx") !== -1, "sanity");
}

// 13. head+tail: beginning AND end survive ------------------------------------
{
  const s = "A".repeat(90000) + "MIDDLE" + "B".repeat(90000);
  const t = P.truncateHeadTail(s, 100000);
  ok(t.startsWith("AAAA"), "head kept");
  ok(t.endsWith("BBBB"), "tail kept");
}

// 14. config sanity -------------------------------------------------------------
ok(C.SYSTEM_PROMPT.includes("TASK_COMPLETE"), "system prompt documents completion");
ok(C.SYSTEM_PROMPT.includes('"commands"'), "system prompt documents command contract");
ok(C.SEND_CAP <= 120000, "send cap within arena hard limit");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
