// ═══════════════════════════════════════════════════════════
// audit-mcp-observation — the AI-observability measurement instrument.
//
// Prints the MCP tool CONTRACT surface and the contract VIOLATIONS that
// the AI-observability audit (AI_OBSERVABILITY_AUDIT_REPORT.md) found:
//
//   1. the per-tool table: name, definition line, declared inputs,
//      required inputs, enum values, output schema presence
//   2. the risk classification (src/mcp/agentTrust.ts)
//   3. tools that declare NO output schema  → an agent has no shape to code against
//   4. behaviour-changing inputs read from `record`/`envelope` that NO tool
//      schema declares → an agent cannot discover the levers it has
//
// READ-ONLY. Parses the TypeScript source with the compiler API (no
// regex on source text — shorthand properties, computed keys and dynamic
// access are invisible to a regex and would make this instrument lie).
//
//   node scripts/audit-mcp-observation.mjs
//   node scripts/audit-mcp-observation.mjs --json
//   node scripts/audit-mcp-observation.mjs --root <checkout>   (audit another checkout)
// ═══════════════════════════════════════════════════════════
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = (() => {
  const flag = process.argv.indexOf("--root");
  if (flag >= 0 && process.argv[flag + 1]) return resolve(process.argv[flag + 1]);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
})();
const asJson = process.argv.includes("--json");

const TOOLS_REL = "src/mcp/tools.ts";
const TRUST_REL = "src/mcp/agentTrust.ts";

// ── source loading ──────────────────────────────────────────────────────
function load(rel) {
  const abs = resolve(root, rel);
  const text = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return { abs, text, sf };
}

const toolsFile = load(TOOLS_REL);
const trustFile = load(TRUST_REL);

// A map of every top-level `const X = <expr>` so a schema referenced by
// name (outputSchema: OUTPUT_METER) can be resolved to its literal.
const consts = new Map();
for (const st of toolsFile.sf.statements) {
  if (!ts.isVariableStatement(st)) continue;
  for (const d of st.declarationList.declarations) {
    if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer);
  }
}

function resolveNode(node, depth = 0) {
  if (!node || depth > 8) return node;
  if (ts.isIdentifier(node) && consts.has(node.text)) return resolveNode(consts.get(node.text), depth + 1);
  return node;
}

function objProp(obj, name) {
  const o = resolveNode(obj);
  if (!o || !ts.isObjectLiteralExpression(o)) return null;
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && p.name && p.name.getText && p.name.getText() === name) return p.initializer;
  }
  return null;
}

function stringOf(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = stringOf(node.left);
    const r = stringOf(node.right);
    return typeof l === "string" && typeof r === "string" ? l + r : null;
  }
  return null;
}

function declaredProps(schema) {
  const s = resolveNode(schema);
  const props = objProp(s, "properties");
  if (!props || !ts.isObjectLiteralExpression(props)) return [];
  return props.properties.filter((p) => ts.isPropertyAssignment(p) && p.name).map((p) => p.name.getText());
}

function requiredProps(schema) {
  const s = resolveNode(schema);
  const req = objProp(s, "required");
  if (!req || !ts.isArrayLiteralExpression(req)) return [];
  return req.elements.map((e) => (ts.isStringLiteral(e) ? e.text : null)).filter(Boolean);
}

function enumValues(schema) {
  const s = resolveNode(schema);
  const props = objProp(s, "properties");
  const out = {};
  if (!props || !ts.isObjectLiteralExpression(props)) return out;
  for (const p of props.properties) {
    if (!ts.isPropertyAssignment(p) || !p.name) continue;
    const value = resolveNode(p.initializer);
    if (!value || !ts.isObjectLiteralExpression(value)) continue;
    const en = objProp(value, "enum");
    if (en && ts.isArrayLiteralExpression(en)) {
      out[p.name.getText()] = en.elements.map((e) =>
        ts.isStringLiteral(e) ? e.text : ts.isNumericLiteral(e) ? Number(e.text) : null,
      );
    }
  }
  return out;
}

// ── the tool table ─────────────────────────────────────────────────────
function findVar(sf, name) {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name) return d.initializer;
    }
  }
  return null;
}

const toolsArray = findVar(toolsFile.sf, "MCP_TOOLS");
if (!toolsArray || !ts.isArrayLiteralExpression(toolsArray)) {
  console.error("MCP_TOOLS array literal not found — the source shape changed.");
  process.exit(2);
}

const tools = [];
for (const el of toolsArray.elements) {
  if (!ts.isObjectLiteralExpression(el)) continue;
  const name = stringOf(objProp(el, "name"));
  if (!name) continue;
  const { line } = toolsFile.sf.getLineAndCharacterOfPosition(el.getStart(toolsFile.sf));
  const inSchema = objProp(el, "inputSchema");
  const outSchema = objProp(el, "outputSchema");
  tools.push({
    name,
    line: line + 1,
    inputs: declaredProps(inSchema),
    required: requiredProps(inSchema),
    enums: enumValues(inSchema),
    hasOutputSchema: Boolean(outSchema),
    outputProps: declaredProps(outSchema),
  });
}

// ── the risk table ─────────────────────────────────────────────────────
const riskObject = findVar(trustFile.sf, "TOOL_RISK");
const risk = {};
if (riskObject && ts.isObjectLiteralExpression(riskObject)) {
  for (const p of riskObject.properties) {
    if (!ts.isPropertyAssignment(p) || !p.name) continue;
    const key = p.name.getText().replace(/^["']|["']$/g, "");
    risk[key] = stringOf(p.initializer) ?? "unknown";
  }
}

// ── the runtime-augmented envelope properties ──────────────────────────
// tools.ts augments every tool's schema with these three; they are
// declared nowhere in the literal, by design.
const AUGMENTED = ["requestId", "agentId", "dryRun"];

// ── violation 1: tools without an output schema ────────────────────────
const withoutOutputSchema = tools.filter((t) => !t.hasOutputSchema).map((t) => t.name);

// ── violation 2: behaviour-changing inputs declared in no schema ───────
// Every property read off the TOOL-ARGS record, minus every property any
// tool declares, minus the augmented envelope.
//
// Scope matters: `record` is also the name of a CHECKPOINT record
// (tools.ts:8519) and a METER snapshot record (tools.ts:11186). Those are
// internal data, not tool arguments — counting them would make this
// instrument lie. So a `record.X` read counts only when the nearest
// enclosing function binds `record` to the call arguments.
const declaredEverywhere = new Set(AUGMENTED);
for (const t of tools) for (const p of t.inputs) declaredEverywhere.add(p);

/** the set of functions whose `record` binding IS the tool-args record */
const argsRecordFunctions = new Set();
function collectArgsRecordBindings(sf) {
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "record") {
      const init = node.initializer ? node.initializer.getText(sf) : "";
      if (init.includes("args")) {
        let fn = node.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        if (fn) argsRecordFunctions.add(fn);
      }
    }
    // The tool executors take the args as a PARAMETER: (ctx, record).
    // A `record` that is a loop variable over persisted checkpoints
    // (hydrateCheckpoints) or a meter snapshot (describeMeter) is NOT
    // the tool args and must not be counted.
    if (ts.isFunctionLike(node) && node.parameters.length >= 2) {
      const first = node.parameters[0].name;
      if (ts.isIdentifier(first) && first.text === "ctx") {
        for (const p of node.parameters) {
          if (ts.isIdentifier(p.name) && p.name.text === "record") argsRecordFunctions.add(node);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
collectArgsRecordBindings(toolsFile.sf);

function enclosingFunction(node) {
  let fn = node.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  return fn ?? null;
}

/** reads of a property off a binding that carries the tool arguments.
 *  Returns { envelope: Set, tool: Set } — the two are DIFFERENT contracts.
 *
 *  A tool-local `scope` (kyx_meter: master|tracks|fx|all) does NOT declare
 *  the ENVELOPE `scope` (the path-confinement declaration). Mixing the two
 *  buckets hides a real gap behind a name collision, so they are kept apart. */
function toolArgReads(sf) {
  const envelope = new Set();
  const tool = new Set();
  const record = (node, base) => {
    const arg = node.argumentExpression;
    const isArgsBinding =
      base === "envelope" || (base === "record" && argsRecordFunctions.has(enclosingFunction(node)));
    if (!isArgsBinding) return;
    if (ts.isPropertyAccessExpression(node)) {
      (base === "envelope" ? envelope : tool).add(node.name.text);
    } else if (ts.isElementAccessExpression(node) && arg && ts.isStringLiteral(arg)) {
      (base === "envelope" ? envelope : tool).add(arg.text);
    }
  };
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      record(node, node.expression.text);
    }
    // Element access: envelope["scope"], envelope["projectRevision"].
    // The guard modules use this form, so a property-access-only detector
    // would silently miss two of the most consequential inputs.
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      record(node, node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { envelope, tool };
}

const envelopeReads = new Set();
const toolReads = new Set();

// The ENVELOPE contract — the properties read off the raw call envelope by
// the GUARD modules. These modules only ever see the envelope, so their
// reads are envelope-contract by definition.
const guardEnvelopeReads = new Set();

// NOTE: reuse the ALREADY-PARSED source for tools.ts. Re-parsing it here
// would produce a second AST, and `argsRecordFunctions` holds nodes from
// the first one — the identity check would then never match and every
// `record.X` read would silently vanish from the report.
const GUARD_MODULES = ["src/mcp/permissionLattice.ts", "src/mcp/scope-guard.ts", "src/mcp/write-conflict.ts"];
const SCAN_TARGETS = [{ sf: toolsFile.sf }, ...GUARD_MODULES.map((rel) => ({ sf: load(rel).sf, guard: true }))];
for (const { sf, guard } of SCAN_TARGETS) {
  const reads = toolArgReads(sf);
  for (const p of reads.envelope) {
    envelopeReads.add(p);
    if (guard) guardEnvelopeReads.add(p);
  }
  for (const p of reads.tool) toolReads.add(p);
}

// `__kyx_resource` is a HIDDEN transport channel (tools.ts:7343) that the
// servers use to route resources/read. It is not one of the 40 public
// tools, so its input is not an undeclared tool input.
const HIDDEN_CHANNEL_INPUTS = new Set(["uri"]);

// An input is UNDECLARED when the MCP layer reads it off the call
// arguments and NO tool schema declares it.
//
// One name collision needs an explicit exception: three tools declare a
// tool-LOCAL `scope` (kyx_meter: master|tracks|fx|all, kyx_render_summary,
// kyx_diagnose_mix). That is a different concept from the ENVELOPE `scope`
// (the path-confinement declaration), and the envelope one is read by
// scope-guard.ts — so it must not be excused by those three declarations.
const undeclaredInputs = [...new Set([...envelopeReads, ...toolReads])]
  .filter((p) => !AUGMENTED.includes(p))
  .filter((p) => !HIDDEN_CHANNEL_INPUTS.has(p))
  .filter((p) => !declaredEverywhere.has(p) || guardEnvelopeReads.has(p))
  .sort();

const undeclaredEnvelopeInputs = undeclaredInputs.filter((p) => guardEnvelopeReads.has(p));
const undeclaredToolInputs = undeclaredInputs.filter((p) => !guardEnvelopeReads.has(p));

// ── report ──────────────────────────────────────────────────────────────
const report = {
  tools: tools.length,
  toolNames: tools.map((t) => t.name),
  withOutputSchema: tools.length - withoutOutputSchema.length,
  withoutOutputSchema,
  riskCounts: Object.values(risk).reduce((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {}),
  toolsWithoutRiskEntry: tools.map((t) => t.name).filter((n) => risk[n] === undefined),
  undeclaredInputs,
  table: tools,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nMCP tool contract — ${report.tools} tools, ${report.withOutputSchema} with an output schema\n`);
  console.log(`${pad("tool", 24)}${pad("risk", 12)}${pad("out", 5)}${pad("line", 7)}inputs`);
  console.log("─".repeat(100));
  for (const t of tools) {
    console.log(
      `${pad(t.name, 24)}${pad(risk[t.name] ?? "(default: mutate)", 12)}${pad(t.hasOutputSchema ? "yes" : "NO", 5)}${pad(t.line, 7)}${t.inputs.join(", ")}`,
    );
  }
  console.log(`\nRISK DISTRIBUTION  ${JSON.stringify(report.riskCounts)}`);
  console.log(`\nNO OUTPUT SCHEMA (${withoutOutputSchema.length}):\n  ${withoutOutputSchema.join("\n  ")}`);
  console.log(
    `\nUNDECLARED ENVELOPE INPUTS (${undeclaredEnvelopeInputs.length}):\n  ${undeclaredEnvelopeInputs.join("\n  ")}`,
  );
  console.log(`\nUNDECLARED TOOL INPUTS (${undeclaredToolInputs.length}):\n  ${undeclaredToolInputs.join("\n  ")}`);
  if (report.toolsWithoutRiskEntry.length > 0) {
    console.log(`\nNO RISK ENTRY (defaults to "mutate"):\n  ${report.toolsWithoutRiskEntry.join("\n  ")}`);
  }
  console.log("");
}
