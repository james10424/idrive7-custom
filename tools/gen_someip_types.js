"use strict";
/**
 * Writes shared/car/someip.d.ts: the types of the SOME/IP fields and events the apps read, from BMW's interface
 * catalog (someip-interfaces.json, not in the repo).
 *
 *   node tools/gen_someip_types.js [path/to/someip-interfaces.json]
 *   (default: $SOMEIP_CATALOG, else ~/Downloads/github/bmw_sdk/someip-interfaces.json)
 *
 * Which ones: an interface whose name is written in the code (shared/, kit/runtime/, bench/run-app.js, the apps'
 * app.json), and of it the fields and events whose names are written there too; then every type they reach. Run it
 * again after adding a signal.
 *
 * What the code gets: `Fields[iface][field]` is the payload a handler receives, and `Handlers` types a handler map
 * as ctx.signals.watch and the kit Car take it (`$pollMs` included). Structs have every member optional (a car or
 * the bench may send part of one); enums are their names or wire numbers, as the binding hands over either.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "shared", "car", "someip.d.ts");
const CATALOG =
  process.argv[2] ||
  process.env.SOMEIP_CATALOG ||
  path.join(os.homedir(), "Downloads", "github", "bmw_sdk", "someip-interfaces.json");

/** @type {Record<string, string>} the catalog's primitive types */
const PRIM = {
  Bool: "boolean",
  Int8: "number",
  Int16: "number",
  Int32: "number",
  Int64: "number",
  UInt8: "number",
  UInt16: "number",
  UInt32: "number",
  UInt64: "number",
  Float: "number",
  Double: "number",
  string: "string",
  Utf8D: "string",
  Utf8F: "string",
  Utf16D: "string",
  ByteBuffer: "Buffer | number[]",
};

/**
 * Every file the code that reads signals lives in.
 * @returns {string}
 */
function sourceText() {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir @param {RegExp} re */
  const walk = (dir, re) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p, re);
      else if (re.test(name) && !name.endsWith(".d.ts")) files.push(p);
    }
  };
  walk(path.join(ROOT, "shared"), /\.js$/);
  walk(path.join(ROOT, "kit", "runtime"), /\.js$/);
  walk(path.join(ROOT, "apps"), /^app\.json$/);
  files.push(path.join(ROOT, "bench", "run-app.js"));
  return files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
}

function main() {
  if (!fs.existsSync(CATALOG)) {
    console.error("no catalog at " + CATALOG + " (pass its path, or set SOMEIP_CATALOG)");
    process.exit(1);
  }
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
  /** @type {Record<string, *>} */
  const types = catalog.datatypes;
  /** @type {Record<string, *>} */
  const ifaces = catalog.interfaces;
  const text = sourceText();
  /** @type {(word: string) => boolean} */
  const written = (word) => new RegExp("\\b" + word.replace(/\./g, "\\.") + "\\b").test(text);

  /** @type {Record<string, Record<string, string>>} interface -> field -> its type's catalog name */
  const used = {};
  for (const iface of Object.keys(ifaces).sort()) {
    if (!written(iface)) continue;
    const members = Object.assign({}, ifaces[iface].fields || {}, ifaces[iface].events || {});
    for (const field of Object.keys(members).sort()) {
      if (!written(field)) continue;
      const member = members[field];
      // a field carries one type (dataRef); an event its arguments (one struct, as the binding hands it over)
      const ref =
        member.dataRef ||
        (member.arguments && member.arguments.length === 1 ? member.arguments[0].dataRef : null);
      if (!ref) continue;
      (used[iface] = used[iface] || {})[field] = ref;
    }
  }

  /** @type {Set<string>} the catalog types to declare */
  const need = new Set();
  /** @param {string} ref */
  const reach = (ref) => {
    if (!ref || PRIM[ref] || need.has(ref)) return;
    const t = types[ref];
    if (!t) return;
    need.add(ref);
    (t.members || []).forEach((/** @type {*} */ m) => reach(m.dataRef));
    reach(t.dataRef);
    reach(t.keyDataRef);
    reach(t.valueDataRef);
  };
  Object.values(used).forEach((fields) => Object.values(fields).forEach(reach));

  /** @type {(ref: string) => string} a type reference as TypeScript writes it */
  const tsRef = (ref) => PRIM[ref] || (types[ref] ? ref : "unknown");

  // declarations grouped by namespace (the catalog name without its last part)
  /** @type {Record<string, string[]>} */
  const byNs = {};
  for (const ref of [...need].sort()) {
    const t = types[ref],
      ns = ref.slice(0, ref.lastIndexOf(".")),
      name = ref.slice(ref.lastIndexOf(".") + 1);
    let decl;
    if (t.type === "struct" || t.type === "union") {
      const members = (t.members || []).map(
        (/** @type {*} */ m) => "    " + m.name + "?: " + tsRef(m.dataRef) + ";",
      );
      decl =
        (t.type === "union" ? "  /** a union: one of these members */\n" : "") +
        "  interface " + name + " {\n" + members.join("\n") + (members.length ? "\n" : "") + "  }";
    } else if (t.type === "enum") {
      const items = Object.entries(t.items || {}).sort((a, b) => Number(a[1]) - Number(b[1]));
      decl =
        "  /** " + items.map(([k, v]) => k + " " + v).join(", ") + " */\n" +
        "  type " + name + " = " + items.map(([k]) => JSON.stringify(k)).concat("number").join(" | ") + ";";
    } else if (t.type === "array") {
      decl = "  type " + name + " = " + "(" + tsRef(t.dataRef) + ")[];";
    } else if (t.type === "typedef") {
      decl = "  type " + name + " = " + tsRef(t.dataRef) + ";";
    } else if (t.type === "map") {
      decl = "  type " + name + " = Record<string | number, " + tsRef(t.valueDataRef) + ">;";
    } else decl = "  type " + name + " = unknown;";
    (byNs[ns] = byNs[ns] || []).push(decl);
  }

  const out = [
    "// Generated by tools/gen_someip_types.js from BMW's someip-interfaces.json (catalog " +
      (catalog.version || "?") + "): edit that, not this.",
    "// The SOME/IP fields and events the apps read (their names written in shared/, kit/runtime/, bench/run-app.js or an",
    "// app.json) and every type they reach. Struct members are all optional; enums are their names or wire numbers.",
    "",
  ];
  for (const ns of Object.keys(byNs).sort()) {
    out.push("export namespace " + ns + " {", byNs[ns].join("\n\n"), "}", "");
  }
  out.push("/** interface -> field or event -> the payload its handler receives */", "export interface Fields {");
  for (const iface of Object.keys(used)) {
    out.push("  " + JSON.stringify(iface) + ": {");
    for (const field of Object.keys(used[iface]))
      out.push("    " + field + ": " + tsRef(used[iface][field]) + ";");
    out.push("  };");
  }
  out.push(
    "}",
    "",
    "/** A handler map for one interface (ctx.signals.watch, the kit Car's extras): one handler per field it reads;",
    " * $pollMs: re-read the fields that often. */",
    "export type HandlersOf<I extends keyof Fields> = { [F in keyof Fields[I]]?: (msg: Fields[I][F]) => void } & {",
    "  $pollMs?: number;",
    "};",
    "/** Handler maps by interface (an interface the code reads is in Fields once this file is generated again). */",
    "export type Handlers = { [I in keyof Fields]?: HandlersOf<I> };",
    "",
  );
  fs.writeFileSync(OUT, out.join("\n"));
  const nFields = Object.values(used).reduce((n, f) => n + Object.keys(f).length, 0);
  console.log(
    "wrote " + path.relative(ROOT, OUT) + ": " + Object.keys(used).length + " interfaces, " + nFields +
      " fields and events, " + need.size + " types",
  );
}

main();
