#!/usr/bin/env node

// src/discovery/discover-repositories.ts
import fs from "fs/promises";
import path2 from "path";

// src/utils/path-utils.ts
import path from "path";
function normalizePath(value) {
  return value.split(path.sep).join("/");
}
function relativePath(root, value) {
  return normalizePath(path.relative(root, value) || ".");
}
function ensureLeadingSlash(value) {
  return value.startsWith("/") ? value : `/${value}`;
}
function stripQuotes(value) {
  return value.replace(/^['"`]|['"`]$/g, "");
}

// src/discovery/discover-repositories.ts
async function discoverRepositories(rootPath, ignore) {
  const root = path2.resolve(rootPath);
  const ignored = new Set(ignore);
  const found = [];
  async function isRealGitMarker(dir) {
    const gitPath = path2.join(dir, ".git");
    try {
      const st = await fs.stat(gitPath);
      if (st.isDirectory()) {
        const children = await fs.readdir(gitPath);
        return children.includes("HEAD") || children.includes("config");
      }
      if (st.isFile()) {
        const text = await fs.readFile(gitPath, "utf8");
        return text.trimStart().startsWith("gitdir:");
      }
    } catch {
    }
    try {
      const fixture = await fs.stat(path2.join(dir, ".git-fixture"));
      return fixture.isFile() || fixture.isDirectory();
    } catch {
      return false;
    }
  }
  async function walk(dir) {
    const rel = relativePath(root, dir);
    if (rel !== "." && rel.split("/").some((part) => ignored.has(part))) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasMarker = entries.some((e) => e.name === ".git" || e.name === ".git-fixture");
    if (hasMarker && await isRealGitMarker(dir)) {
      found.push({
        name: path2.basename(dir),
        absolutePath: dir,
        relativePath: relativePath(root, dir),
        isGitRepo: true
      });
    }
    for (const entry of entries)
      if (entry.isDirectory() && !ignore.includes(entry.name))
        await walk(path2.join(dir, entry.name));
  }
  await walk(root);
  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

// src/parsers/package-json-parser.ts
import fs2 from "fs/promises";
import path3 from "path";
function recordOfString(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => typeof v === "string")
  );
}
function readRequires(cds) {
  const requires = cds && typeof cds === "object" && "requires" in cds ? cds.requires : void 0;
  if (!requires || typeof requires !== "object") return [];
  return Object.entries(requires).flatMap(([alias, raw]) => {
    if (!raw || typeof raw !== "object") return [];
    const obj = raw;
    const credentials = obj.credentials && typeof obj.credentials === "object" ? obj.credentials : {};
    return [
      {
        alias,
        kind: typeof obj.kind === "string" ? obj.kind : void 0,
        model: typeof obj.model === "string" ? obj.model : void 0,
        destination: typeof credentials.destination === "string" ? credentials.destination : void 0,
        servicePath: typeof credentials.path === "string" ? credentials.path : void 0,
        requestTimeout: typeof credentials.requestTimeout === "number" ? credentials.requestTimeout : void 0,
        rawJson: JSON.stringify(raw)
      }
    ];
  });
}
async function parsePackageJson(repoPath) {
  try {
    const raw = await fs2.readFile(path3.join(repoPath, "package.json"), "utf8");
    const json = JSON.parse(raw);
    return {
      packageName: typeof json.name === "string" ? json.name : void 0,
      packageVersion: typeof json.version === "string" ? json.version : void 0,
      dependencies: {
        ...recordOfString(json.dependencies),
        ...recordOfString(json.devDependencies)
      },
      cdsRequires: readRequires(json.cds),
      scripts: recordOfString(json.scripts)
    };
  } catch {
    return { dependencies: {}, cdsRequires: [], scripts: {} };
  }
}

// src/parsers/cds-parser.ts
import fs3 from "fs/promises";
import path4 from "path";
function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}
function maskCommentsAndStrings(text) {
  let out = "";
  let mode = "code";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? "";
    const n = text[i + 1] ?? "";
    if (mode === "code" && c === "/" && n === "/") {
      mode = "line";
      out += "  ";
      i += 1;
      continue;
    }
    if (mode === "code" && c === "/" && n === "*") {
      mode = "block";
      out += "  ";
      i += 1;
      continue;
    }
    if (mode === "line" && c === "\n") mode = "code";
    if (mode === "block" && c === "*" && n === "/") {
      mode = "code";
      out += "  ";
      i += 1;
      continue;
    }
    if (mode === "code" && (c === "'" || c === '"' || c === "`")) {
      mode = c === "'" ? "single" : c === '"' ? "double" : "template";
      out += " ";
      continue;
    }
    if (mode === "single" && c === "'" || mode === "double" && c === '"' || mode === "template" && c === "`")
      mode = "code";
    out += mode === "code" || c === "\n" ? c : " ";
  }
  return out;
}
function readAnnotation(text, index) {
  if (text[index] !== "@") return void 0;
  let i = index + 1;
  while (/\s/.test(text[i] ?? "")) i += 1;
  if (text[i] !== "(") return void 0;
  let depth = 0;
  for (; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    if (text[i] === ")") depth -= 1;
    if (depth === 0) return { end: i + 1, raw: text.slice(index, i + 1) };
  }
  return void 0;
}
function collectAnnotations(text, index) {
  let i = index;
  let raw = "";
  while (i < text.length) {
    while (/\s/.test(text[i] ?? "")) i += 1;
    const annotation = readAnnotation(text, i);
    if (!annotation) break;
    raw += annotation.raw;
    i = annotation.end;
  }
  return { end: i, raw };
}
function pathAnnotation(raw) {
  return /path\s*:\s*['"]([^'"]+)['"]/s.exec(raw)?.[1];
}
function matchingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") depth -= 1;
    if (depth === 0) return i;
  }
  return text.length - 1;
}
function operationsFromBody(text, maskedBody, bodyOffset, filePath) {
  return [...maskedBody.matchAll(/\b(action|function|event)\s+(\w+)\s*(?:\(([^)]*)\))?\s*(?:returns\s+([^;{]+))?/g)].map((m) => ({
    operationType: m[1] ?? "action",
    operationName: m[2] ?? "unknown",
    operationPath: ensureLeadingSlash(m[2] ?? "unknown"),
    paramsJson: JSON.stringify((m[3] ?? "").split(",").map((part) => part.trim()).filter(Boolean)),
    returnType: m[4]?.trim(),
    sourceFile: normalizePath(filePath),
    sourceLine: lineOf(text, bodyOffset + (m.index ?? 0))
  }));
}
async function parseCdsFile(repoPath, filePath) {
  const absolute = path4.join(repoPath, filePath);
  const text = await fs3.readFile(absolute, "utf8");
  const masked = maskCommentsAndStrings(text);
  const namespace = /namespace\s+([\w.]+)\s*;/.exec(masked)?.[1];
  const services = [];
  const pendingAnnotations = [];
  for (const a of masked.matchAll(/@\s*\(/g)) {
    const annotation = collectAnnotations(masked, a.index ?? 0);
    pendingAnnotations.push(annotation);
  }
  const serviceRegex = /\b(extend\s+)?service\s+([\w.]+)\b/g;
  let match;
  while (match = serviceRegex.exec(masked)) {
    const afterName = collectAnnotations(masked, serviceRegex.lastIndex);
    const open = masked.indexOf("{", afterName.end);
    if (open === -1) continue;
    const matchIndex = match.index;
    const prefix = pendingAnnotations.filter((a) => a.end <= matchIndex && matchIndex - a.end < 8).map((a) => a.raw).join("");
    const annotations = `${prefix}${afterName.raw}`;
    const end = matchingBrace(masked, open);
    const body = masked.slice(open + 1, end);
    const name = match[2] ?? "UnknownService";
    const serviceName = name.split(".").pop() ?? name;
    const servicePath = ensureLeadingSlash(pathAnnotation(annotations) ?? serviceName);
    services.push({
      namespace,
      serviceName,
      qualifiedName: name.includes(".") ? name : namespace ? `${namespace}.${name}` : name,
      servicePath,
      isExtend: Boolean(match[1]),
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, match.index),
      operations: operationsFromBody(text, body, open + 1, filePath)
    });
    serviceRegex.lastIndex = end + 1;
  }
  const baseOps = new Map(services.filter((s) => !s.isExtend).map((s) => [s.qualifiedName, s.operations]));
  for (const service of services.filter((s) => s.isExtend && s.operations.length === 0)) {
    const inherited = baseOps.get(service.qualifiedName) ?? baseOps.get(service.serviceName);
    if (inherited) service.operations = inherited.map((op) => ({ ...op, sourceFile: service.sourceFile, sourceLine: service.sourceLine }));
  }
  return services;
}

// src/parsers/decorator-parser.ts
import fs4 from "fs/promises";
import path5 from "path";
import ts2 from "typescript";

// src/parsers/ts-project.ts
import ts from "typescript";
function createSourceFile(filePath, text) {
  return ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS
  );
}

// src/parsers/decorator-parser.ts
function line(sf, pos) {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}
function decs(node) {
  return ts2.canHaveDecorators(node) ? [...ts2.getDecorators(node) ?? []] : [];
}
function callName(d) {
  const e = d.expression;
  return ts2.isCallExpression(e) ? e.expression.getText() : e.getText();
}
function firstArg(d) {
  const e = d.expression;
  return ts2.isCallExpression(e) && e.arguments[0] ? e.arguments[0].getText() : "";
}
async function parseDecorators(repoPath, filePath) {
  const text = await fs4.readFile(path5.join(repoPath, filePath), "utf8");
  const sf = createSourceFile(filePath, text);
  const constants = /* @__PURE__ */ new Map();
  const handlers = [];
  function visit(node) {
    if (ts2.isVariableDeclaration(node) && ts2.isIdentifier(node.name) && node.initializer && ts2.isStringLiteralLike(node.initializer))
      constants.set(node.name.text, node.initializer.text);
    if (ts2.isClassDeclaration(node)) {
      const className = node.name?.text ?? "AnonymousHandler";
      const hasHandler = decs(node).some((d) => callName(d) === "Handler");
      const methods = node.members.filter(ts2.isMethodDeclaration).flatMap(
        (m) => decs(m).filter(
          (d) => ["Func", "Action", "On", "Event"].includes(callName(d))
        ).map((d) => {
          const raw = firstArg(d);
          const value = raw.startsWith('"') || raw.startsWith("'") || raw.startsWith("`") ? stripQuotes(raw) : constants.get(raw) ?? (raw.endsWith(".name") ? raw.split(".").at(-2) : void 0);
          return {
            methodName: m.name.getText(),
            decoratorKind: callName(d),
            decoratorValue: value,
            decoratorRawExpression: raw,
            sourceFile: normalizePath(filePath),
            sourceLine: line(sf, m.getStart())
          };
        })
      );
      if (hasHandler || methods.length > 0)
        handlers.push({
          className,
          sourceFile: normalizePath(filePath),
          sourceLine: line(sf, node.getStart()),
          methods
        });
    }
    ts2.forEachChild(node, visit);
  }
  visit(sf);
  return handlers;
}

// src/parsers/handler-registration-parser.ts
import fsSync from "fs";
import fs5 from "fs/promises";
import path6 from "path";
import ts3 from "typescript";
var MAX_EXPORT_DEPTH = 5;
function lineOf2(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}
function isRelative(source) {
  return source.startsWith("./") || source.startsWith("../");
}
function sourceText(node, sourceFile) {
  if (ts3.isIdentifier(node) || ts3.isStringLiteral(node) || ts3.isNumericLiteral(node)) return node.text;
  return node.getText(sourceFile);
}
function importSourceFor(identifier, imports) {
  const evidence = imports.get(identifier);
  return evidence ? `${evidence.source}#${evidence.importedName}` : void 0;
}
async function parseHandlerRegistrations(repoPath, filePath) {
  const absolutePath = path6.join(repoPath, filePath);
  const text = await fs5.readFile(absolutePath, "utf8");
  const sourceFile = ts3.createSourceFile(filePath, text, ts3.ScriptTarget.Latest, true, ts3.ScriptKind.TS);
  const imports = collectImports(sourceFile);
  const localArrays = collectLocalArrays(sourceFile, imports, /* @__PURE__ */ new Map(), repoPath, filePath);
  const out = [];
  function emitFromExpression(expression, call) {
    const classes = resolveArrayExpression(expression, localArrays, imports, repoPath, filePath, /* @__PURE__ */ new Set());
    for (const cls of classes) {
      out.push({
        className: cls.className,
        importSource: cls.importSource,
        registrationFile: normalizePath(filePath),
        registrationLine: lineOf2(sourceFile, call),
        registrationKind: "combined-handler-class",
        confidence: 0.95
      });
    }
    if (classes.length === 0) {
      out.push({
        registrationFile: normalizePath(filePath),
        registrationLine: lineOf2(sourceFile, call),
        registrationKind: "combined-handler",
        confidence: 0.75
      });
    }
  }
  function visit(node) {
    if (ts3.isCallExpression(node) && isRegistrationCall(node)) {
      const handlerExpr = handlerExpression(node, sourceFile);
      if (handlerExpr) emitFromExpression(handlerExpr, node);
      else out.push({ registrationFile: normalizePath(filePath), registrationLine: lineOf2(sourceFile, node), registrationKind: "combined-handler", confidence: 0.75 });
    }
    ts3.forEachChild(node, visit);
  }
  visit(sourceFile);
  return out;
}
function isRegistrationCall(call) {
  const text = call.expression.getText();
  return text.endsWith("createCombinedHandler") || text.endsWith("srv.prepend") || text.endsWith("cds.serve");
}
function handlerExpression(call, sourceFile) {
  for (const arg of call.arguments) {
    if (!ts3.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.properties) {
      if (!ts3.isPropertyAssignment(prop)) continue;
      if (sourceText(prop.name, sourceFile) === "handler") return prop.initializer;
    }
  }
  return void 0;
}
function collectImports(sourceFile) {
  const imports = /* @__PURE__ */ new Map();
  for (const statement of sourceFile.statements) {
    if (!ts3.isImportDeclaration(statement) || !ts3.isStringLiteral(statement.moduleSpecifier)) continue;
    const source = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) imports.set(clause.name.text, { importedName: "default", source });
    const named = clause.namedBindings;
    if (named && ts3.isNamedImports(named)) {
      for (const element of named.elements) imports.set(element.name.text, { importedName: element.propertyName?.text ?? element.name.text, source });
    }
    if (named && ts3.isNamespaceImport(named)) imports.set(named.name.text, { importedName: "*", source });
  }
  return imports;
}
function collectLocalArrays(sourceFile, imports, seed, repoPath = "", fromFile = "") {
  const arrays = new Map(seed);
  for (const statement of sourceFile.statements) {
    if (ts3.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts3.isIdentifier(decl.name) && decl.initializer && ts3.isArrayLiteralExpression(decl.initializer)) {
          arrays.set(decl.name.text, resolveArrayLiteral(decl.initializer, arrays, imports, repoPath, fromFile, /* @__PURE__ */ new Set()));
        }
      }
    }
  }
  return arrays;
}
function resolveArrayExpression(expr, arrays, imports, repoPath, fromFile, seen) {
  if (ts3.isArrayLiteralExpression(expr)) return resolveArrayLiteral(expr, arrays, imports, repoPath, fromFile, seen);
  if (ts3.isIdentifier(expr)) {
    const local = arrays.get(expr.text);
    if (local) return local;
    const evidence = imports.get(expr.text);
    if (evidence && isRelative(evidence.source)) return resolveImportedArray(repoPath, fromFile, evidence, seen);
    if (evidence) return [{ className: evidence.importedName === "default" ? expr.text : evidence.importedName, importSource: `${evidence.source}#${evidence.importedName}` }];
  }
  return [];
}
function resolveArrayLiteral(array, arrays, imports, repoPath, fromFile, seen) {
  const out = [];
  for (const element of array.elements) {
    if (ts3.isSpreadElement(element)) out.push(...resolveArrayExpression(element.expression, arrays, imports, repoPath, fromFile, seen));
    else if (ts3.isIdentifier(element)) out.push({ className: element.text, importSource: importSourceFor(element.text, imports) });
  }
  return out;
}
function resolveImportedArray(repoPath, fromFile, evidence, seen) {
  const moduleFile = resolveRelativeModule(repoPath, fromFile, evidence.source);
  if (!moduleFile) return [];
  const key = `${moduleFile}:${evidence.importedName}`;
  if (seen.has(key) || seen.size > MAX_EXPORT_DEPTH) return [];
  seen.add(key);
  const exports = readExports(repoPath, moduleFile, seen);
  if (evidence.importedName === "default") return exports.defaultArray ?? [];
  return exports.arrays.get(evidence.importedName) ?? exports.arrays.get(exports.aliases.get(evidence.importedName) ?? evidence.importedName) ?? [];
}
function resolveRelativeModule(repoPath, fromFile, specifier) {
  const base = path6.resolve(repoPath, path6.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.js`, path6.join(base, "index.ts"), path6.join(base, "index.js")]) {
    try {
      const stat = fsSync.statSync(candidate);
      if (stat.isFile()) return normalizePath(path6.relative(repoPath, candidate));
    } catch {
    }
  }
  return void 0;
}
function readExports(repoPath, filePath, seen) {
  const absolute = path6.join(repoPath, filePath);
  let text;
  try {
    text = fsSync.readFileSync(absolute, "utf8");
  } catch {
    return { arrays: /* @__PURE__ */ new Map(), aliases: /* @__PURE__ */ new Map() };
  }
  const sourceFile = ts3.createSourceFile(filePath, text, ts3.ScriptTarget.Latest, true, ts3.ScriptKind.TS);
  const imports = collectImports(sourceFile);
  const arrays = collectLocalArrays(sourceFile, imports, /* @__PURE__ */ new Map(), repoPath, filePath);
  const aliases = /* @__PURE__ */ new Map();
  let defaultArray;
  for (const statement of sourceFile.statements) {
    if (ts3.isExportAssignment(statement) && ts3.isIdentifier(statement.expression)) defaultArray = arrays.get(statement.expression.text);
    if (ts3.isExportDeclaration(statement) && statement.exportClause && ts3.isNamedExports(statement.exportClause)) {
      const module = statement.moduleSpecifier && ts3.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : void 0;
      for (const element of statement.exportClause.elements) {
        const local = element.propertyName?.text ?? element.name.text;
        aliases.set(element.name.text, local);
        if (module && isRelative(module)) {
          const imported = resolveImportedArray(repoPath, filePath, { source: module, importedName: local }, seen);
          if (imported.length > 0) arrays.set(element.name.text, imported);
        }
      }
    }
  }
  return { arrays, defaultArray, aliases };
}

// src/utils/redaction.ts
var SENSITIVE = /authorization|cookie|token|secret|password|key|credential/i;
function redactText(text) {
  return text.replace(
    /(authorization|cookie|token|secret|password|key|credential)\s*[:=]\s*(['"`]?)[^,'"`}\s]+\2/gi,
    "$1: [REDACTED]"
  );
}
function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value))
      out[k] = SENSITIVE.test(k) ? "[REDACTED]" : redactValue(v);
    return out;
  }
  return typeof value === "string" ? redactText(value) : value;
}
function summarizeExpression(text) {
  return redactText(text).slice(0, 240);
}

// src/linker/odata-path-normalizer.ts
function normalizeODataOperationInvocationPath(path9) {
  if (path9 === void 0) return void 0;
  const raw = path9.trim();
  if (!raw) return void 0;
  const rejected = (reason) => ({ rawOperationPath: raw, normalizedOperationPath: raw, wasInvocation: false, invocationArgumentPlaceholderKeys: [], normalizationRejectedReason: reason });
  const open = raw.indexOf("(");
  if (open < 0) return rejected("no_top_level_parenthesis");
  const query = topLevelQueryIndex(raw);
  if (query >= 0) return rejected("query_string_paths_are_not_operation_invocations");
  if (!raw.startsWith("/")) return rejected("path_is_not_absolute");
  if (raw.slice(1, open).includes("/")) return rejected("operation_segment_contains_navigation_separator");
  const close = matchingClose(raw, open);
  if (close === void 0) return rejected("top_level_invocation_parenthesis_is_unbalanced");
  if (raw.slice(close + 1).trim().length > 0) return rejected("top_level_invocation_does_not_cover_remaining_path");
  const operationSegment = raw.slice(0, open).trim();
  if (operationSegment.length <= 1) return rejected("operation_segment_is_empty");
  return {
    rawOperationPath: raw,
    normalizedOperationPath: operationSegment,
    wasInvocation: true,
    invocationArgumentPlaceholderKeys: [...new Set(extractTemplatePlaceholders(raw.slice(open + 1, close)))],
    normalizationReason: "balanced_top_level_operation_invocation"
  };
}
function classifyODataPathIntent(path9, method) {
  const rawPath = (path9 ?? "").trim();
  const normalizedMethod = (method ?? "GET").trim().toUpperCase() || "GET";
  const queryIndex = rawPath.indexOf("?");
  const pathWithoutQuery = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath;
  const queryString = queryIndex >= 0 ? rawPath.slice(queryIndex + 1) : void 0;
  const segments = pathWithoutQuery.replace(/^\//, "").split("/").filter(Boolean);
  const firstSegment = segments[0] ?? "";
  const hasNavigationSegments = segments.length > 1;
  const entitySegment = entitySegmentFromPath(pathWithoutQuery);
  const placeholderKeys = [...new Set(extractTemplatePlaceholders(rawPath))];
  const base = { rawPath, method: normalizedMethod, pathWithoutQuery, queryString, hasQueryString: queryIndex >= 0, entitySegment, placeholderKeys };
  if (!rawPath || !rawPath.startsWith("/")) return { ...base, kind: "unknown", reason: "path_missing_or_not_absolute" };
  const upperEntityLike = /^[A-Z][A-Za-z0-9_]*$/.test(entitySegment ?? firstSegment);
  const mediaLike = ["content", "$value"].includes((segments.at(-1) ?? "").toLowerCase());
  const invocation = normalizeODataOperationInvocationPath(pathWithoutQuery);
  if (normalizedMethod !== "GET") {
    if (invocation?.wasInvocation && looksLikeLowerCamelInvocation(firstSegment)) return { ...base, kind: "operation_invocation", reason: "non_get_balanced_top_level_operation_invocation" };
    if (mediaLike) return { ...base, kind: "entity_media", reason: "non_get_entity_media_stream_path" };
    if (hasNavigationSegments || firstSegment.includes("(")) return { ...base, kind: normalizedMethod === "DELETE" ? "entity_delete" : "entity_mutation", reason: "non_get_entity_path_shape" };
    if (upperEntityLike) return { ...base, kind: normalizedMethod === "DELETE" ? "entity_delete" : "entity_mutation", reason: "non_get_entity_path_shape" };
    return { ...base, kind: "operation_invocation", reason: "non_get_lowercase_path_may_be_operation" };
  }
  if (queryIndex >= 0) {
    if (hasNavigationSegments) return { ...base, kind: "entity_navigation_query", reason: "get_path_has_navigation_and_query_string" };
    if (looksLikeLowerCamelInvocation(firstSegment)) return { ...base, kind: "unknown", reason: "get_invocation_with_query_string_requires_indexed_operation_evidence" };
    return { ...base, kind: "entity_query", reason: "get_collection_path_has_query_string" };
  }
  if (hasNavigationSegments) return mediaLike ? { ...base, kind: "entity_media", reason: "get_entity_media_stream_path" } : { ...base, kind: "entity_navigation_query", reason: "get_path_has_navigation_segments" };
  if (firstSegment.includes("(")) {
    if (invocation?.wasInvocation && looksLikeLowerCamelInvocation(firstSegment)) return { ...base, kind: "operation_invocation", reason: "get_balanced_top_level_operation_invocation" };
    return looksLikeLowerCamelInvocation(firstSegment) ? { ...base, kind: "operation_invocation", reason: "get_single_lower_camel_segment_has_top_level_invocation" } : { ...base, kind: "entity_key_read", reason: "get_entity_segment_has_key_predicate" };
  }
  if (/^[A-Z][A-Za-z0-9_]*$/.test(firstSegment)) return { ...base, kind: "entity_candidate", reason: "uppercase_collection_segment_without_indexed_entity_evidence" };
  return { ...base, kind: "unknown", reason: "get_path_has_no_query_key_or_navigation_signal" };
}
function entitySegmentFromPath(path9) {
  const first = path9.replace(/^\//, "").split("/")[0]?.trim();
  if (!first) return void 0;
  const open = first.indexOf("(");
  const entity = (open >= 0 ? first.slice(0, open) : first).trim();
  return entity || void 0;
}
function looksLikeLowerCamelInvocation(segment) {
  const open = segment.indexOf("(");
  if (open <= 0) return false;
  const name = segment.slice(0, open).split(".").at(-1) ?? segment.slice(0, open);
  return /^[a-z][A-Za-z0-9_]*$/.test(name);
}
function extractTemplatePlaceholders(text) {
  const keys = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] !== "$" || text[index + 1] !== "{") continue;
    const close = matchingPlaceholderClose(text, index + 1);
    if (close === void 0) continue;
    const key = text.slice(index + 2, close).trim();
    if (key) keys.push(key);
    index = close;
  }
  return keys;
}
function matchingClose(text, openIndex) {
  let depth = 0;
  let quote;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if (quote) {
      if (prev === "\\") continue;
      if (quote === "template" && char === "$" && text[index + 1] === "{") {
        const close = matchingPlaceholderClose(text, index + 1);
        if (close === void 0) return void 0;
        index = close;
        continue;
      }
      if (quote === "single" && char === "'" || quote === "double" && char === '"' || quote === "template" && char === "`") quote = void 0;
      continue;
    }
    if (char === "$" && text[index + 1] === "{") {
      const close = matchingPlaceholderClose(text, index + 1);
      if (close === void 0) return void 0;
      index = close;
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (char === "`") {
      quote = "template";
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return void 0;
    }
  }
  return void 0;
}
function matchingPlaceholderClose(text, openBraceIndex) {
  let depth = 0;
  let quote;
  for (let index = openBraceIndex; index < text.length; index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if (quote) {
      if (prev === "\\") continue;
      if (quote === "template" && char === "$" && text[index + 1] === "{") {
        depth += 1;
        index += 1;
        continue;
      }
      if (quote === "single" && char === "'" || quote === "double" && char === '"' || quote === "template" && char === "`") quote = void 0;
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (char === "`") {
      quote = "template";
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return void 0;
    }
  }
  return void 0;
}
function topLevelQueryIndex(text) {
  let quote;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if (quote) {
      if (prev === "\\") continue;
      if (quote === "template" && char === "$" && text[index + 1] === "{") {
        const close = matchingPlaceholderClose(text, index + 1);
        if (close === void 0) return -1;
        index = close;
        continue;
      }
      if (quote === "single" && char === "'" || quote === "double" && char === '"' || quote === "template" && char === "`") quote = void 0;
      continue;
    }
    if (char === "$" && text[index + 1] === "{") {
      const close = matchingPlaceholderClose(text, index + 1);
      if (close === void 0) return -1;
      index = close;
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (char === "`") {
      quote = "template";
      continue;
    }
    if (char === "?") return index;
  }
  return -1;
}

// src/parsers/outbound-call-parser.ts
import fs6 from "fs/promises";
import path7 from "path";
import ts4 from "typescript";

// src/linker/external-http-target.ts
import { createHash } from "crypto";
var sensitiveKeys = /* @__PURE__ */ new Set(["token", "access_token", "id_token", "api_key", "apikey", "key", "password", "passwd", "pwd", "secret", "client_secret", "authorization", "cookie", "signature"]);
function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
function methodPrefix(method) {
  return typeof method === "string" && method.length > 0 ? `${method.toUpperCase()} ` : "";
}
function redactUrl(value) {
  try {
    const url = new URL(value, value.startsWith("/") ? "https://relative.invalid" : void 0);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, sensitiveKeys.has(key.toLowerCase()) ? "<redacted>" : "<redacted>");
    const path9 = `${url.pathname}${url.search ? url.search : ""}`;
    return value.startsWith("/") ? path9 : `${url.origin}${path9}`;
  } catch {
    return value.replace(/([?&][^=;&]*(?:token|key|password|secret|cookie|authorization)[^=;&]*=)[^&]*/gi, "$1<redacted>");
  }
}
function externalHttpTarget(call) {
  const evidence = typeof call.evidence_json === "string" ? safeParse(call.evidence_json) : {};
  const target = evidence.externalTarget && typeof evidence.externalTarget === "object" && !Array.isArray(evidence.externalTarget) ? evidence.externalTarget : {};
  const method = typeof call.method === "string" ? call.method : typeof target.method === "string" ? target.method : void 0;
  const kind = typeof target.kind === "string" ? target.kind : "unknown";
  const expression = typeof target.expression === "string" ? target.expression : void 0;
  if (kind === "destination" && target.dynamic === true) {
    const shape = typeof target.expressionShape === "string" ? target.expressionShape : "expression";
    const candidates = Array.isArray(target.candidateLiterals) ? target.candidateLiterals.filter((item) => typeof item === "string") : [];
    return { kind, toKind: "external_destination", toId: `destination:dynamic:${hash(`${shape}:${candidates.join("|")}`)}`, label: "External destination: dynamic destination", method, dynamic: true, expression: candidates.length ? `candidates:${candidates.join("|")}` : `shape:${shape}` };
  }
  if (kind === "destination" && expression) return { kind, toKind: "external_destination", toId: `destination:${expression}`, label: `External destination: ${expression}`, method, dynamic: false, expression };
  if (kind === "static_url" && expression) {
    const redacted = redactUrl(expression);
    return { kind, toKind: "external_endpoint", toId: `endpoint:${hash(`${method ?? ""}:${redacted}`)}`, label: `External endpoint: ${methodPrefix(method)}${redacted}`, method, dynamic: false, expression: redacted };
  }
  if (kind === "url_expression" && expression) return { kind, toKind: "external_endpoint", toId: `dynamic:${hash(expression)}`, label: `External endpoint: ${methodPrefix(method)}dynamic URL`, method, dynamic: true, expression: `expr:${hash(expression)}` };
  return { kind: "unknown", toKind: "external_endpoint", toId: "unknown", label: "External endpoint: unknown", method, dynamic: false };
}
function safeParse(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// src/parsers/outbound-call-parser.ts
function lineOf3(text, idx) {
  return text.slice(0, idx).split("\n").length;
}
function entityFromExpression(expr) {
  if (!expr) return void 0;
  if (ts4.isIdentifier(expr) || ts4.isStringLiteral(expr) || ts4.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts4.isPropertyAccessExpression(expr) && expr.expression.kind === ts4.SyntaxKind.ThisKeyword) return expr.name.text;
  if (ts4.isElementAccessExpression(expr) && expr.argumentExpression && (ts4.isStringLiteral(expr.argumentExpression) || ts4.isNoSubstitutionTemplateLiteral(expr.argumentExpression))) return expr.argumentExpression.text;
  return void 0;
}
function expressionName(expr) {
  if (ts4.isIdentifier(expr)) return expr.text;
  if (ts4.isPropertyAccessExpression(expr)) return `${expressionName(expr.expression)}.${expr.name.text}`;
  return expr.getText();
}
function variableInitializers(source) {
  const initializers = /* @__PURE__ */ new Map();
  const visit = (node) => {
    if (ts4.isVariableDeclaration(node) && ts4.isIdentifier(node.name) && node.initializer && (node.parent.flags & ts4.NodeFlags.Const) !== 0) initializers.set(node.name.text, node.initializer);
    ts4.forEachChild(node, visit);
  };
  visit(source);
  return initializers;
}
function queryEntityFromAst(expr, initializers = /* @__PURE__ */ new Map()) {
  if (ts4.isParenthesizedExpression(expr) || ts4.isAwaitExpression(expr)) return queryEntityFromAst(expr.expression, initializers);
  if (ts4.isIdentifier(expr) && initializers.has(expr.text)) return queryEntityFromAst(initializers.get(expr.text), initializers);
  if (ts4.isCallExpression(expr)) {
    const name = expressionName(expr.expression);
    if (name === "cds.run") return queryEntityFromAst(expr.arguments[0], initializers);
    if (["SELECT.one.from", "SELECT.from", "SELECT.one", "INSERT.into", "UPSERT.into", "DELETE.from", "UPDATE.entity"].includes(name)) return entityFromExpression(expr.arguments[0]);
    if (name === "UPDATE") return entityFromExpression(expr.arguments[0]);
    const receiver = ts4.isPropertyAccessExpression(expr.expression) ? expr.expression.expression : void 0;
    if (receiver) return queryEntityFromAst(receiver, initializers);
  }
  return void 0;
}
function extractQueryEntity(expr) {
  const source = ts4.createSourceFile("query.ts", `const __query = (${expr});`, ts4.ScriptTarget.Latest, true, ts4.ScriptKind.TS);
  const initializers = variableInitializers(source);
  let found;
  const visit = (node) => {
    if (found) return;
    if (ts4.isParenthesizedExpression(node)) found = queryEntityFromAst(node.expression, initializers);
    ts4.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
function queryWarning(expr) {
  if (/^\s*[`'"]/.test(expr)) return "raw_sql_or_cql_expression";
  if (/^\s*\w+\s*$/.test(expr)) return "query_variable_without_static_initializer";
  return "dynamic_entity_expression";
}
function parserEvidence(source, node, extra) {
  return { parser: "typescript_ast", startOffset: node.getStart(source), endOffset: node.getEnd(), ...extra };
}
function isStringLike(expr) {
  return Boolean(expr && (ts4.isStringLiteral(expr) || ts4.isNoSubstitutionTemplateLiteral(expr)));
}
function literalText(expr) {
  if (isStringLike(expr)) return expr.text;
  return void 0;
}
function objectPropertyText(object, key) {
  const prop = object.properties.find(
    (property) => ts4.isPropertyAssignment(property) && nameOfProperty(property.name) === key || ts4.isShorthandPropertyAssignment(property) && property.name.text === key
  );
  if (!prop) return void 0;
  return ts4.isShorthandPropertyAssignment(prop) ? prop.name.text : prop.initializer.getText();
}
function objectPropertyIsShorthand(object, key) {
  return object.properties.some((property) => ts4.isShorthandPropertyAssignment(property) && property.name.text === key);
}
function nameOfProperty(name) {
  if (ts4.isIdentifier(name) || ts4.isStringLiteral(name) || ts4.isNumericLiteral(name)) return name.text;
  return void 0;
}
function staticExpressionText(expr, initializers) {
  if (!expr) return void 0;
  if (isStringLike(expr)) return expr.text;
  if (ts4.isIdentifier(expr) && initializers.has(expr.text)) return staticExpressionText(initializers.get(expr.text), initializers);
  return void 0;
}
function destinationExpressionShape(expr) {
  if (!expr) return void 0;
  if (ts4.isIdentifier(expr)) return "identifier";
  if (ts4.isPropertyAccessExpression(expr) || ts4.isElementAccessExpression(expr)) return "property_read";
  if (ts4.isCallExpression(expr)) return "function_call";
  if (ts4.isConditionalExpression(expr)) return "conditional";
  if (ts4.isBinaryExpression(expr)) return "binary_expression";
  if (ts4.isTemplateExpression(expr)) return "template_expression";
  return ts4.SyntaxKind[expr.kind] ?? "expression";
}
function staticConditionalCandidates(expr, initializers) {
  const resolved2 = expr && ts4.isIdentifier(expr) && initializers.has(expr.text) ? initializers.get(expr.text) : expr;
  if (!resolved2 || !ts4.isConditionalExpression(resolved2)) return void 0;
  const left = staticExpressionText(resolved2.whenTrue, initializers);
  const right = staticExpressionText(resolved2.whenFalse, initializers);
  if (!left || !right) return void 0;
  return [.../* @__PURE__ */ new Set([left, right])];
}
function propertyInitializer(object, key) {
  for (const property of object.properties) {
    if (ts4.isPropertyAssignment(property) && nameOfProperty(property.name) === key) return property.initializer;
    if (ts4.isShorthandPropertyAssignment(property) && property.name.text === key) return property.name;
  }
  return void 0;
}
function httpMethodFromObject(object, initializers) {
  const text = staticExpressionText(propertyInitializer(object, "method"), initializers);
  return text ? stripQuotes(text).toUpperCase() : void 0;
}
function urlTargetFromExpression(expr, initializers) {
  const text = staticExpressionText(expr, initializers);
  if (text) return { kind: "static_url", expression: text, dynamic: false };
  if (expr && (ts4.isTemplateExpression(expr) || ts4.isIdentifier(expr) || ts4.isPropertyAccessExpression(expr) || ts4.isCallExpression(expr))) return { kind: "url_expression", expression: expr.getText(expr.getSourceFile()), dynamic: true };
  return { kind: "unknown", dynamic: false };
}
function destinationTargetFromExpression(expr, initializers) {
  const text = staticExpressionText(expr, initializers);
  if (text) return { kind: "destination", expression: text, dynamic: false };
  const candidates = staticConditionalCandidates(expr, initializers);
  if (candidates) return { kind: "destination", dynamic: true, expressionShape: "conditional", candidateLiterals: candidates };
  const shape = destinationExpressionShape(expr);
  if (shape) return { kind: "destination", dynamic: true, expressionShape: shape };
  return void 0;
}
function externalHttpEvidence(node, source, initializers) {
  const expr = node.expression;
  const exprText = expr.getText(source);
  if (exprText === "useOrFetchDestination") {
    const objectArg = node.arguments[0];
    if (objectArg && ts4.isObjectLiteralExpression(objectArg)) {
      const destination = destinationTargetFromExpression(propertyInitializer(objectArg, "destinationName"), initializers);
      return { externalTarget: destination ?? { kind: "unknown", dynamic: false }, classifier: "sap_destination_lookup", sourceCallShape: "useOrFetchDestination" };
    }
  }
  if (exprText === "executeHttpRequest") {
    const destination = destinationTargetFromExpression(node.arguments[0], initializers);
    const config = node.arguments[1];
    const method = config && ts4.isObjectLiteralExpression(config) ? httpMethodFromObject(config, initializers) : void 0;
    const url = config && ts4.isObjectLiteralExpression(config) ? urlTargetFromExpression(propertyInitializer(config, "url"), initializers) : { kind: "unknown", dynamic: false };
    return { method, externalTarget: destination ? { ...url, destination } : url, classifier: "sap_execute_http_request", sourceCallShape: "executeHttpRequest" };
  }
  if (exprText === "axios") {
    const config = node.arguments[0];
    if (config && ts4.isObjectLiteralExpression(config)) {
      const method = httpMethodFromObject(config, initializers);
      return { method, externalTarget: urlTargetFromExpression(propertyInitializer(config, "url"), initializers), classifier: "axios_config_call", sourceCallShape: "axios(config)" };
    }
    return { externalTarget: { kind: "unknown", dynamic: false }, classifier: "axios_unknown_call", sourceCallShape: "axios(...)" };
  }
  if (exprText === "fetch") {
    const init = node.arguments[1];
    const method = init && ts4.isObjectLiteralExpression(init) ? httpMethodFromObject(init, initializers) : void 0;
    return { method, externalTarget: urlTargetFromExpression(node.arguments[0], initializers), classifier: "fetch_call", sourceCallShape: "fetch" };
  }
  if (ts4.isPropertyAccessExpression(expr) && ["get", "post", "put", "patch", "delete", "head"].includes(expr.name.text) && expr.expression.getText(source) === "axios") {
    return { method: expr.name.text.toUpperCase(), externalTarget: urlTargetFromExpression(node.arguments[0], initializers), classifier: "axios_member_call", sourceCallShape: `axios.${expr.name.text}` };
  }
  return void 0;
}
function collectServiceVariables(source) {
  const vars = /* @__PURE__ */ new Set(["cds", "messaging", "messageClient", "eventClient"]);
  const visit = (node) => {
    if (ts4.isVariableDeclaration(node) && ts4.isIdentifier(node.name) && node.initializer) {
      const text = node.initializer.getText(source);
      if (/cds\.connect\.(to|messaging)\s*\(/.test(text)) vars.add(node.name.text);
    }
    ts4.forEachChild(node, visit);
  };
  visit(source);
  return vars;
}
function receiverName(expr) {
  if (ts4.isIdentifier(expr)) return expr.text;
  if (ts4.isPropertyAccessExpression(expr)) return expr.getText(sourceOf(expr));
  return void 0;
}
function sourceOf(node) {
  return node.getSourceFile();
}
function rootReceiverName(expr) {
  if (ts4.isIdentifier(expr)) return expr.text;
  if (ts4.isPropertyAccessExpression(expr)) return rootReceiverName(expr.expression);
  if (ts4.isCallExpression(expr)) return rootReceiverName(expr.expression);
  return void 0;
}
function isSupportedEventReceiver(receiver, rootReceiver, serviceVariables) {
  const candidate = rootReceiver ?? receiver;
  if (!candidate) return false;
  if (candidate === "cds") return true;
  if (serviceVariables.has(candidate)) return true;
  if (receiver && serviceVariables.has(receiver)) return true;
  if (/^(srv|service|serviceClient|messaging|messageClient|eventClient)$/.test(candidate)) return true;
  return false;
}
function collectWrapperSpecs(source) {
  const specs = /* @__PURE__ */ new Map();
  const scanFunction = (name, fn) => {
    const params = fn.parameters.map((param) => ts4.isIdentifier(param.name) ? param.name.text : void 0);
    const closure = returnedClosure(fn);
    if (!closure) return;
    const sends = [];
    const visit = (node) => {
      if (ts4.isCallExpression(node) && ts4.isPropertyAccessExpression(node.expression) && node.expression.name.text === "send" && ts4.isIdentifier(node.expression.expression)) {
        const objectArg = node.arguments[0];
        if (objectArg && ts4.isObjectLiteralExpression(objectArg)) {
          const pathProp = objectArg.properties.find((property) => ts4.isShorthandPropertyAssignment(property) && property.name.text === "path");
          if (pathProp) sends.push({ client: node.expression.expression.text, path: pathProp.name.text, method: objectPropertyText(objectArg, "method") });
        }
      }
      ts4.forEachChild(node, visit);
    };
    visit(closure);
    if (sends.length !== 1) return;
    const found = sends[0];
    const clientIndex = params.indexOf(found.client);
    const pathIndex = params.indexOf(found.path);
    const methodIndex = found.method && params.includes(found.method) ? params.indexOf(found.method) : void 0;
    if (clientIndex >= 0 && pathIndex >= 0) specs.set(name, { clientIndex, pathIndex, methodIndex, definitionLine: lineOf3(source.text, fn.getStart(source)), internalStart: closure.getStart(source), internalEnd: closure.getEnd() });
  };
  for (const stmt of source.statements) {
    if (ts4.isFunctionDeclaration(stmt) && stmt.name) scanFunction(stmt.name.text, stmt);
    if (ts4.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) if (ts4.isIdentifier(decl.name) && decl.initializer && (ts4.isArrowFunction(decl.initializer) || ts4.isFunctionExpression(decl.initializer))) scanFunction(decl.name.text, decl.initializer);
    }
  }
  return specs;
}
function returnedClosure(fn) {
  const body = fn.body;
  if (!body) return void 0;
  if (ts4.isArrowFunction(fn) && !ts4.isBlock(body)) return ts4.isArrowFunction(body) || ts4.isFunctionExpression(body) ? body : void 0;
  if (!ts4.isBlock(body)) return void 0;
  const returns = body.statements.filter(ts4.isReturnStatement);
  if (returns.length !== 1) return void 0;
  const expr = returns[0]?.expression;
  return expr && (ts4.isArrowFunction(expr) || ts4.isFunctionExpression(expr)) ? expr : void 0;
}
function classifyOutboundCallsInSource(source, filePath) {
  const calls = [];
  const sourceFile = normalizePath(filePath);
  const initializers = variableInitializers(source);
  const serviceVariables = collectServiceVariables(source);
  const wrapperSpecs = collectWrapperSpecs(source);
  const wrapperInternalRanges = [...wrapperSpecs.values()].map((spec) => ({ start: spec.internalStart, end: spec.internalEnd }));
  const add = (node, fact, extra) => {
    calls.push({ node, fact: { ...fact, sourceFile, sourceLine: lineOf3(source.text, node.getStart(source)), confidence: fact.confidence ?? 0.8, evidence: parserEvidence(source, node, extra) } });
  };
  const visit = (node) => {
    if (ts4.isCallExpression(node)) {
      if (wrapperInternalRanges.some((range) => node.getStart(source) >= range.start && node.getEnd() <= range.end)) {
        return;
      }
      const expr = node.expression;
      const exprText = expr.getText(source);
      if (exprText === "cds.run") {
        const arg = node.arguments[0];
        const entity = arg ? queryEntityFromAst(arg, initializers) : void 0;
        const payload = arg?.getText(source) ?? "";
        add(node, { callType: "local_db_query", queryEntity: entity, payloadSummary: summarizeExpression(payload), confidence: entity ? 0.9 : 0.55, unresolvedReason: entity ? void 0 : queryWarning(payload) });
      } else if (ts4.isPropertyAccessExpression(expr) && expr.name.text === "send" && (ts4.isIdentifier(expr.expression) || ts4.isPropertyAccessExpression(expr.expression))) {
        const objectArg = node.arguments[0];
        if (objectArg && ts4.isObjectLiteralExpression(objectArg)) {
          const receiver = receiverName(expr.expression);
          const query = objectPropertyText(objectArg, "query");
          const method = stripQuotes(objectPropertyText(objectArg, "method") ?? "POST");
          const op = objectPropertyText(objectArg, "path") ?? objectPropertyText(objectArg, "event");
          const shorthandPath = objectPropertyIsShorthand(objectArg, "path");
          const operationPathExpr = op && !shorthandPath ? `/${stripQuotes(op).replace(/^\//, "")}` : void 0;
          const intent = classifyODataPathIntent(operationPathExpr, method);
          const entityCallTypes = { entity_mutation: "remote_entity_mutation", entity_delete: "remote_entity_delete", entity_media: "remote_entity_media", entity_candidate: "remote_entity_candidate" };
          const entityCallType = entityCallTypes[intent.kind];
          const isODataQueryRead = method.toUpperCase() === "GET" && ["entity_query", "entity_key_read", "entity_navigation_query"].includes(intent.kind);
          add(node, { callType: query ? "remote_query" : entityCallType ?? (isODataQueryRead ? "remote_query" : "remote_action"), serviceVariableName: receiver, method, operationPathExpr, queryEntity: query ? extractQueryEntity(query) : isODataQueryRead ? intent.entitySegment : void 0, payloadSummary: summarizeExpression(objectArg.getText(source)), confidence: op || query ? 0.8 : 0.4, unresolvedReason: !query && shorthandPath ? "dynamic_operation_path_identifier" : void 0 }, { receiver, classifier: "service_client_send_object", operationPathExpression: shorthandPath ? op : void 0, odataPathIntent: operationPathExpr ? intent : void 0, parserWarning: shorthandPath ? "dynamic_operation_path_identifier" : void 0 });
        }
      } else if (ts4.isCallExpression(expr) && ts4.isIdentifier(expr.expression) && wrapperSpecs.has(expr.expression.text) || ts4.isIdentifier(expr) && wrapperSpecs.has(expr.text)) {
        const wrapperName = ts4.isIdentifier(expr) ? expr.text : ts4.isCallExpression(expr) && ts4.isIdentifier(expr.expression) ? expr.expression.text : "";
        const wrapperArgs = ts4.isIdentifier(expr) ? node.arguments : ts4.isCallExpression(expr) ? expr.arguments : node.arguments;
        const spec = wrapperSpecs.get(wrapperName);
        const clientArg = spec ? wrapperArgs[spec.clientIndex] : void 0;
        const pathArg = spec ? wrapperArgs[spec.pathIndex] : void 0;
        const methodArg = spec?.methodIndex === void 0 ? void 0 : wrapperArgs[spec.methodIndex];
        if (spec && clientArg && ts4.isIdentifier(clientArg) && isStringLike(pathArg)) {
          add(node, { callType: "remote_action", serviceVariableName: clientArg.text, method: stripQuotes(methodArg?.getText(source) ?? "POST"), operationPathExpr: `/${pathArg.text.replace(/^\//, "")}`, payloadSummary: summarizeExpression(node.getText(source)), confidence: 0.75 }, { receiver: clientArg.text, classifier: "higher_order_wrapper_literal_path", wrapperFunction: wrapperName, wrapperDefinitionLine: spec.definitionLine, literalCallerArgumentDetected: true });
        } else if (spec && clientArg && ts4.isIdentifier(clientArg)) {
          add(node, { callType: "remote_action", serviceVariableName: clientArg.text, method: stripQuotes(methodArg?.getText(source) ?? "POST"), payloadSummary: summarizeExpression(node.getText(source)), confidence: 0.45, unresolvedReason: "dynamic_operation_path_identifier" }, { receiver: clientArg.text, classifier: "higher_order_wrapper_dynamic_path", wrapperFunction: wrapperName, wrapperDefinitionLine: spec.definitionLine, parserWarning: "dynamic_operation_path_identifier" });
        }
      } else if (ts4.isPropertyAccessExpression(expr) && ["emit", "publish", "on"].includes(expr.name.text)) {
        const receiver = receiverName(expr.expression);
        const rootReceiver = rootReceiverName(expr.expression);
        if (isSupportedEventReceiver(receiver, rootReceiver, serviceVariables)) {
          const eventName = literalText(node.arguments[0]);
          if (eventName) add(node, { callType: expr.name.text === "on" ? "async_subscribe" : "async_emit", serviceVariableName: rootReceiver ?? receiver, eventNameExpr: eventName }, { receiver, rootReceiver, classifier: expr.name.text === "on" ? "cap_service_event_subscription" : "cap_service_event_emit", receiverClassification: "cap_evidence" });
        }
      } else {
        const external = externalHttpEvidence(node, source, initializers);
        if (external) {
          const evidenceTarget = { ...external.externalTarget, method: external.method, parserClassifier: external.classifier, sourceCallShape: external.sourceCallShape };
          const safeTarget = externalHttpTarget({ method: external.method, evidence_json: JSON.stringify({ externalTarget: evidenceTarget }) });
          add(node, { callType: "external_http", method: external.method, payloadSummary: void 0, confidence: 0.7, unresolvedReason: "External HTTP destination is outside indexed CAP services", externalTarget: { kind: safeTarget.kind, stableId: safeTarget.toId, label: safeTarget.label, dynamic: safeTarget.dynamic } }, { classifier: external.classifier, externalTarget: safeTarget, sourceCallShape: external.sourceCallShape });
        }
      }
    }
    ts4.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}
function containsSupportedOutboundCall(node) {
  const source = node.getSourceFile();
  const start = node.getFullStart();
  const end = node.getEnd();
  return classifyOutboundCallsInSource(source, source.fileName).some((call) => call.node.getStart(source) >= start && call.node.getEnd() <= end);
}
async function parseOutboundCalls(repoPath, filePath) {
  const text = await fs6.readFile(path7.join(repoPath, filePath), "utf8");
  const source = ts4.createSourceFile(filePath, text, ts4.ScriptTarget.Latest, true, filePath.endsWith(".ts") ? ts4.ScriptKind.TS : ts4.ScriptKind.JS);
  return [...classifyOutboundCallsInSource(source, filePath).map((call) => call.fact), ...parseLocalServiceCalls(text, filePath)];
}
function parseLocalServiceCalls(text, filePath) {
  const source = ts4.createSourceFile(filePath, text, ts4.ScriptTarget.Latest, true, filePath.endsWith(".ts") ? ts4.ScriptKind.TS : ts4.ScriptKind.JS);
  const aliases = /* @__PURE__ */ new Map();
  const calls = [];
  const visit = (node) => {
    if (ts4.isVariableDeclaration(node) && ts4.isIdentifier(node.name) && node.initializer) {
      const origin = serviceLookup(node.initializer, aliases);
      if (origin) aliases.set(node.name.text, { ...origin, chain: [...origin.chain, node.name.text] });
    }
    if (ts4.isCallExpression(node)) {
      const parsed = serviceOperationCall(node.expression, aliases);
      if (parsed && parsed.operation !== "entities") calls.push({
        callType: "local_service_call",
        operationPathExpr: `/${parsed.operation}`,
        payloadSummary: parsed.service,
        localServiceName: parsed.service,
        localServiceLookup: parsed.lookup,
        aliasChain: parsed.chain,
        sourceFile: normalizePath(filePath),
        sourceLine: lineOf3(text, node.getStart(source)),
        confidence: 0.9,
        unresolvedReason: ["send", "emit", "publish", "on"].includes(parsed.operation) ? "transport_client_method" : void 0,
        evidence: parserEvidence(source, node, {
          classifier: "local_cap_service_call",
          localServiceLookup: parsed.lookup,
          localServiceName: parsed.service,
          operation: parsed.operation,
          aliasChain: parsed.chain
        })
      });
    }
    ts4.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}
function serviceLookup(expr, aliases) {
  if (ts4.isIdentifier(expr)) return aliases.get(expr.text);
  if (ts4.isPropertyAccessExpression(expr) && expr.expression.getText() === "cds.services") return { service: expr.name.text, lookup: expr.getText(), chain: [expr.getText()] };
  if (ts4.isElementAccessExpression(expr) && expr.expression.getText() === "cds.services" && ts4.isStringLiteral(expr.argumentExpression)) return { service: expr.argumentExpression.text, lookup: expr.getText(), chain: [expr.getText()] };
  return void 0;
}
function serviceOperationCall(expr, aliases) {
  if (!ts4.isPropertyAccessExpression(expr)) return void 0;
  const operation = expr.name.text;
  const origin = serviceLookup(expr.expression, aliases);
  if (!origin) return void 0;
  return { ...origin, operation };
}

// src/parsers/service-binding-parser.ts
import fs7 from "fs/promises";
import path8 from "path";
import ts5 from "typescript";
function lineOf4(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
function stringValue(node) {
  if (!node) return void 0;
  if (ts5.isStringLiteralLike(node) || ts5.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts5.isTemplateExpression(node))
    return node.getText().replace(/^`|`$/g, "");
  return node.getText();
}
function placeholders(value) {
  return [...(value ?? "").matchAll(/\$\{([^}]*)\}/g)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
}
function connectFactFromCall(call) {
  const expr = call.expression;
  if (!ts5.isPropertyAccessExpression(expr) || expr.name.text !== "to")
    return void 0;
  const inner = expr.expression;
  if (!ts5.isPropertyAccessExpression(inner) || inner.name.text !== "connect" || inner.expression.getText() !== "cds")
    return void 0;
  const first = call.arguments[0];
  if (!first) return void 0;
  const second = call.arguments[1];
  const objectArg = ts5.isObjectLiteralExpression(first) ? first : second && ts5.isObjectLiteralExpression(second) ? second : void 0;
  let alias;
  let aliasExpr;
  if (ts5.isStringLiteralLike(first) || ts5.isNoSubstitutionTemplateLiteral(first))
    alias = first.text;
  else if (!ts5.isObjectLiteralExpression(first))
    aliasExpr = stringValue(first);
  if ((ts5.isStringLiteralLike(first) || ts5.isNoSubstitutionTemplateLiteral(first)) && !objectArg)
    return { alias: first.text, isDynamic: false, placeholders: [] };
  if (!objectArg && aliasExpr)
    return {
      aliasExpr,
      isDynamic: true,
      placeholders: placeholders(aliasExpr)
    };
  let destinationExpr;
  let servicePathExpr;
  function visitObject(obj) {
    for (const prop of obj.properties) {
      if (!ts5.isPropertyAssignment(prop)) continue;
      const name = ts5.isIdentifier(prop.name) || ts5.isStringLiteralLike(prop.name) ? prop.name.text : void 0;
      if (name === "destination")
        destinationExpr = stringValue(prop.initializer);
      if (name === "path" || name === "servicePath")
        servicePathExpr = stringValue(prop.initializer);
      if (ts5.isObjectLiteralExpression(prop.initializer))
        visitObject(prop.initializer);
    }
  }
  if (objectArg) visitObject(objectArg);
  const ph = [
    ...placeholders(aliasExpr ?? alias),
    ...placeholders(destinationExpr),
    ...placeholders(servicePathExpr)
  ];
  return {
    alias,
    aliasExpr,
    destinationExpr,
    servicePathExpr,
    isDynamic: ph.length > 0 || !destinationExpr && !servicePathExpr,
    placeholders: ph
  };
}
function unwrapCall(expr) {
  if (ts5.isAwaitExpression(expr)) return unwrapCall(expr.expression);
  if (ts5.isParenthesizedExpression(expr)) return unwrapCall(expr.expression);
  if (ts5.isAsExpression(expr) || ts5.isSatisfiesExpression(expr)) return unwrapCall(expr.expression);
  if (ts5.isTypeAssertionExpression(expr)) return unwrapCall(expr.expression);
  if (ts5.isCallExpression(expr)) return expr;
  return void 0;
}
function unwrapIdentityExpression(expr) {
  if (ts5.isAwaitExpression(expr)) return unwrapIdentityExpression(expr.expression);
  if (ts5.isParenthesizedExpression(expr)) return unwrapIdentityExpression(expr.expression);
  if (ts5.isAsExpression(expr) || ts5.isSatisfiesExpression(expr)) return unwrapIdentityExpression(expr.expression);
  if (ts5.isTypeAssertionExpression(expr)) return unwrapIdentityExpression(expr.expression);
  return expr;
}
function findConnectInExpression(expr) {
  const direct = unwrapCall(expr);
  if (direct) {
    const fact = connectFactFromCall(direct);
    if (fact) return fact;
  }
  let found;
  function visit(node) {
    if (found) return;
    if (ts5.isCallExpression(node)) found = connectFactFromCall(node);
    if (!found) ts5.forEachChild(node, visit);
  }
  visit(expr);
  return found;
}
async function readSource(abs) {
  try {
    const text = await fs7.readFile(abs, "utf8");
    return ts5.createSourceFile(
      abs,
      text,
      ts5.ScriptTarget.Latest,
      true,
      ts5.ScriptKind.TS
    );
  } catch {
    return void 0;
  }
}
async function resolveImport(repoPath, fromFile, spec) {
  if (!spec.startsWith(".")) return void 0;
  const rawBase = path8.resolve(repoPath, path8.dirname(fromFile), spec);
  const parsed = path8.parse(rawBase);
  const base = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(parsed.ext) ? path8.join(parsed.dir, parsed.name) : rawBase;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.js`,
    path8.join(base, "index.ts"),
    path8.join(base, "index.js")
  ]) {
    try {
      const st = await fs7.stat(candidate);
      if (st.isFile()) return normalizePath(path8.relative(repoPath, candidate));
    } catch {
    }
  }
  return void 0;
}
async function importsFor(repoPath, filePath, sf) {
  const imports = [];
  for (const stmt of sf.statements) {
    if (!ts5.isImportDeclaration(stmt) || !ts5.isStringLiteralLike(stmt.moduleSpecifier))
      continue;
    const sourceFile = await resolveImport(
      repoPath,
      filePath,
      stmt.moduleSpecifier.text
    );
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name)
      imports.push({
        localName: clause.name.text,
        exportedName: "default",
        sourceFile
      });
    const bindings = clause.namedBindings;
    if (bindings && ts5.isNamedImports(bindings))
      for (const el of bindings.elements)
        imports.push({
          localName: el.name.text,
          exportedName: el.propertyName?.text ?? el.name.text,
          sourceFile
        });
  }
  return imports;
}
function collectReturnedObjectBindings(fn) {
  const bindings = /* @__PURE__ */ new Map();
  const returns = /* @__PURE__ */ new Map();
  function visit(node) {
    if (node !== fn && (ts5.isFunctionDeclaration(node) || ts5.isArrowFunction(node) || ts5.isFunctionExpression(node)))
      return;
    if (ts5.isVariableDeclaration(node) && ts5.isIdentifier(node.name) && node.initializer) {
      const fact = findConnectInExpression(node.initializer);
      if (fact) bindings.set(node.name.text, fact);
    }
    if (ts5.isReturnStatement(node) && node.expression && ts5.isObjectLiteralExpression(node.expression)) {
      for (const prop of node.expression.properties) {
        if (ts5.isShorthandPropertyAssignment(prop)) returns.set(prop.name.text, prop.name.text);
        if (ts5.isPropertyAssignment(prop) && ts5.isIdentifier(prop.initializer)) {
          const propertyName = ts5.isIdentifier(prop.name) || ts5.isStringLiteralLike(prop.name) ? prop.name.text : void 0;
          if (propertyName) returns.set(propertyName, prop.initializer.text);
        }
      }
    }
    ts5.forEachChild(node, visit);
  }
  visit(fn);
  const out = /* @__PURE__ */ new Map();
  for (const [propertyName, variableName] of returns) {
    const fact = bindings.get(variableName);
    if (fact) out.set(propertyName, fact);
  }
  return out;
}
function functionLikeInitializer(expr) {
  if (!expr) return void 0;
  if (ts5.isArrowFunction(expr) || ts5.isFunctionExpression(expr)) return expr;
  return void 0;
}
function directReturnConnectFact(fn) {
  const localBindings = /* @__PURE__ */ new Map();
  let returned;
  function visit(node) {
    if (node !== fn && (ts5.isFunctionDeclaration(node) || ts5.isArrowFunction(node) || ts5.isFunctionExpression(node)))
      return;
    if (ts5.isVariableDeclaration(node) && ts5.isIdentifier(node.name) && node.initializer) {
      const fact = findConnectInExpression(node.initializer);
      if (fact) localBindings.set(node.name.text, fact);
    }
    if (!returned && ts5.isReturnStatement(node) && node.expression)
      returned = node.expression;
    if (!returned) ts5.forEachChild(node, visit);
  }
  visit(fn);
  if (!returned) return void 0;
  if (ts5.isIdentifier(returned)) return localBindings.get(returned.text);
  return findConnectInExpression(returned);
}
function directConnectFactFromFunctionLike(fn) {
  if (ts5.isArrowFunction(fn) && fn.body && !ts5.isBlock(fn.body))
    return findConnectInExpression(fn.body);
  return directReturnConnectFact(fn);
}
function exportedLocalNames(sf) {
  const exports = /* @__PURE__ */ new Map();
  for (const stmt of sf.statements) {
    const direct = ts5.canHaveModifiers(stmt) ? ts5.getModifiers(stmt)?.some(
      (m) => m.kind === ts5.SyntaxKind.ExportKeyword
    ) ?? false : false;
    if (direct && ts5.isFunctionDeclaration(stmt) && stmt.name)
      exports.set(stmt.name.text, stmt.name.text);
    if (direct && ts5.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations)
        if (ts5.isIdentifier(decl.name)) exports.set(decl.name.text, decl.name.text);
    }
    if (!ts5.isExportDeclaration(stmt) || !stmt.exportClause) continue;
    if (!ts5.isNamedExports(stmt.exportClause)) continue;
    for (const el of stmt.exportClause.elements)
      exports.set(el.name.text, el.propertyName?.text ?? el.name.text);
  }
  return exports;
}
async function helperBindings(repoPath, filePath) {
  const sf = await readSource(path8.join(repoPath, filePath));
  if (!sf) return [];
  const sourceFileAst = sf;
  const out = [];
  const exportedLocals = exportedLocalNames(sf);
  const factsByLocal = /* @__PURE__ */ new Map();
  for (const stmt of sf.statements) {
    if (ts5.isFunctionDeclaration(stmt) && stmt.name) {
      const fact = directConnectFactFromFunctionLike(stmt);
      if (fact) factsByLocal.set(stmt.name.text, { ...fact, sourceLine: lineOf4(sf, stmt) });
      for (const [returnedProperty, objectFact] of collectReturnedObjectBindings(stmt))
        factsByLocal.set(`${stmt.name.text}#${returnedProperty}`, { ...objectFact, returnedProperty, sourceLine: lineOf4(sf, stmt) });
    }
    if (ts5.isVariableStatement(stmt))
      for (const decl of stmt.declarationList.declarations) {
        if (!ts5.isIdentifier(decl.name) || !decl.initializer) continue;
        const helper = functionLikeInitializer(decl.initializer);
        if (helper) {
          const directReturn = directConnectFactFromFunctionLike(helper);
          if (directReturn)
            factsByLocal.set(decl.name.text, {
              ...directReturn,
              sourceLine: lineOf4(sourceFileAst, decl)
            });
          for (const [returnedProperty, objectFact] of collectReturnedObjectBindings(helper))
            factsByLocal.set(`${decl.name.text}#${returnedProperty}`, {
              ...objectFact,
              returnedProperty,
              sourceLine: lineOf4(sourceFileAst, decl)
            });
          continue;
        }
        const fact = findConnectInExpression(decl.initializer);
        if (fact)
          factsByLocal.set(decl.name.text, {
            ...fact,
            sourceLine: lineOf4(sourceFileAst, decl)
          });
      }
  }
  for (const [exportedName, localName] of exportedLocals) {
    const fact = factsByLocal.get(localName);
    if (fact)
      out.push({
        ...fact,
        exportedName,
        sourceFile: normalizePath(filePath),
        sourceLine: fact.sourceLine
      });
  }
  for (const [key, fact] of factsByLocal) {
    const [localName, returnedProperty] = key.split("#");
    if (!returnedProperty) continue;
    for (const [exportedName, exportedLocal] of exportedLocals) {
      if (exportedLocal !== localName) continue;
      out.push({ ...fact, exportedName, returnedProperty, sourceFile: normalizePath(filePath), sourceLine: fact.sourceLine });
    }
  }
  return out;
}
async function parseServiceBindings(repoPath, filePath) {
  const sf = await readSource(path8.join(repoPath, filePath));
  if (!sf) return [];
  const sourceFileAst = sf;
  const out = [];
  const imports = await importsFor(repoPath, filePath, sf);
  const helperCache = /* @__PURE__ */ new Map();
  const classHelpers = collectClassHelpers(sourceFileAst);
  const localObjectHelpers = /* @__PURE__ */ new Map();
  for (const stmt of sourceFileAst.statements) {
    if (ts5.isFunctionDeclaration(stmt) && stmt.name) {
      const rows2 = [];
      for (const [returnedProperty, fact] of collectReturnedObjectBindings(stmt))
        rows2.push({ ...fact, exportedName: stmt.name.text, returnedProperty, sourceFile: normalizePath(filePath), sourceLine: lineOf4(sourceFileAst, stmt) });
      if (rows2.length > 0) localObjectHelpers.set(stmt.name.text, rows2);
    }
    if (ts5.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts5.isIdentifier(decl.name)) continue;
        const helper = functionLikeInitializer(decl.initializer);
        if (!helper) continue;
        const rows2 = [];
        for (const [returnedProperty, fact] of collectReturnedObjectBindings(helper))
          rows2.push({ ...fact, exportedName: decl.name.text, returnedProperty, sourceFile: normalizePath(filePath), sourceLine: lineOf4(sourceFileAst, decl) });
        if (rows2.length > 0) localObjectHelpers.set(decl.name.text, rows2);
      }
    }
  }
  async function importedHelpers(localName) {
    const imp = imports.find((i) => i.localName === localName && i.sourceFile);
    if (!imp?.sourceFile) return [];
    if (!helperCache.has(imp.sourceFile))
      helperCache.set(
        imp.sourceFile,
        await helperBindings(repoPath, imp.sourceFile)
      );
    return (helperCache.get(imp.sourceFile) ?? []).filter((h) => h.exportedName === imp.exportedName).map((helper) => ({ imp, helper }));
  }
  async function importedHelper(localName) {
    return (await importedHelpers(localName)).find((row) => !row.helper.returnedProperty);
  }
  function bindingForVariable(variableName) {
    const sourceFile = normalizePath(filePath);
    return [...out].reverse().find((row) => row.variableName === variableName && row.sourceFile === sourceFile);
  }
  function cloneAliasBinding(targetName, sourceName, aliasKind, node) {
    const existing = bindingForVariable(sourceName);
    if (!existing) return;
    out.push({
      ...existing,
      variableName: targetName,
      sourceLine: lineOf4(sourceFileAst, node),
      helperChain: [
        ...existing.helperChain ?? [],
        {
          callerVariable: targetName,
          aliasOf: sourceName,
          aliasKind,
          scopeRule: "same-file-source-order"
        }
      ]
    });
  }
  function recordIdentityAlias(decl) {
    if (!ts5.isIdentifier(decl.name) || !decl.initializer) return;
    const unwrapped = unwrapIdentityExpression(decl.initializer);
    if (!ts5.isIdentifier(unwrapped)) return;
    cloneAliasBinding(decl.name.text, unwrapped.text, "identity", decl);
  }
  async function recordBindingFromExpression(targetName, expr, node, aliasKind) {
    const call = unwrapCall(expr);
    if (!call) return;
    const direct = connectFactFromCall(call);
    if (direct)
      out.push({
        variableName: targetName,
        ...direct,
        sourceFile: normalizePath(filePath),
        sourceLine: lineOf4(sourceFileAst, node),
        helperChain: aliasKind === "assignment" ? [{ callerVariable: targetName, assignedFrom: call.expression.getText(sourceFileAst), aliasKind, scopeRule: "same-file-source-order" }] : void 0
      });
    else if (ts5.isIdentifier(call.expression)) {
      const resolved2 = await importedHelper(call.expression.text);
      if (resolved2)
        out.push({
          variableName: targetName,
          alias: resolved2.helper.alias,
          aliasExpr: resolved2.helper.aliasExpr,
          destinationExpr: resolved2.helper.destinationExpr,
          servicePathExpr: resolved2.helper.servicePathExpr,
          isDynamic: resolved2.helper.isDynamic,
          placeholders: resolved2.helper.placeholders,
          sourceFile: normalizePath(filePath),
          sourceLine: lineOf4(sourceFileAst, node),
          helperChain: [
            {
              callerVariable: targetName,
              ...aliasKind === "assignment" ? { assignedFrom: call.expression.text, aliasKind, scopeRule: "same-file-source-order" } : {},
              importedHelper: call.expression.text,
              importSource: resolved2.imp.sourceFile,
              exportedSymbol: resolved2.imp.exportedName,
              helperSourceFile: resolved2.helper.sourceFile,
              helperSourceLine: resolved2.helper.sourceLine
            }
          ]
        });
    }
  }
  async function recordVariable(decl) {
    if (!ts5.isIdentifier(decl.name) || !decl.initializer) return;
    await recordBindingFromExpression(decl.name.text, decl.initializer, decl, "declaration");
  }
  async function helpersForCall(call) {
    if (!ts5.isIdentifier(call.expression)) return [];
    const local = localObjectHelpers.get(call.expression.text) ?? [];
    const imported = await importedHelpers(call.expression.text);
    return [...local.map((helper) => ({ helper })), ...imported];
  }
  async function recordDestructuredHelper(decl) {
    if (!ts5.isObjectBindingPattern(decl.name) || !decl.initializer) return;
    const call = unwrapCall(decl.initializer);
    if (!call) return;
    const helpers = await helpersForCall(call);
    if (helpers.length === 0) return;
    for (const el of decl.name.elements) {
      if (!ts5.isIdentifier(el.name)) continue;
      const propertyName = el.propertyName && ts5.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
      const matches = helpers.filter((row) => row.helper.returnedProperty === propertyName);
      if (matches.length !== 1) continue;
      const resolved2 = matches[0];
      out.push({
        variableName: el.name.text,
        alias: resolved2.helper.alias,
        aliasExpr: resolved2.helper.aliasExpr,
        destinationExpr: resolved2.helper.destinationExpr,
        servicePathExpr: resolved2.helper.servicePathExpr,
        isDynamic: resolved2.helper.isDynamic,
        placeholders: resolved2.helper.placeholders,
        sourceFile: normalizePath(filePath),
        sourceLine: lineOf4(sourceFileAst, decl),
        helperChain: [{ callerVariable: el.name.text, helperFunction: call.expression.getText(sourceFileAst), returnedProperty: propertyName, importSource: resolved2.imp?.sourceFile, exportedSymbol: resolved2.imp?.exportedName, helperSourceFile: resolved2.helper.sourceFile, helperSourceLine: resolved2.helper.sourceLine }]
      });
    }
  }
  async function recordDestructuredAssignment(pattern, expr, node) {
    const call = unwrapCall(expr);
    if (!call) return;
    const helpers = await helpersForCall(call);
    if (helpers.length === 0) return;
    for (const prop of pattern.properties) {
      let propertyName;
      let targetName;
      if (ts5.isShorthandPropertyAssignment(prop)) {
        propertyName = prop.name.text;
        targetName = prop.name.text;
      } else if (ts5.isPropertyAssignment(prop)) {
        propertyName = ts5.isIdentifier(prop.name) || ts5.isStringLiteralLike(prop.name) ? prop.name.text : void 0;
        targetName = ts5.isIdentifier(prop.initializer) ? prop.initializer.text : void 0;
      }
      if (!propertyName || !targetName) continue;
      const matches = helpers.filter((row) => row.helper.returnedProperty === propertyName);
      if (matches.length !== 1) continue;
      const resolved2 = matches[0];
      out.push({
        variableName: targetName,
        alias: resolved2.helper.alias,
        aliasExpr: resolved2.helper.aliasExpr,
        destinationExpr: resolved2.helper.destinationExpr,
        servicePathExpr: resolved2.helper.servicePathExpr,
        isDynamic: resolved2.helper.isDynamic,
        placeholders: resolved2.helper.placeholders,
        sourceFile: normalizePath(filePath),
        sourceLine: lineOf4(sourceFileAst, node),
        helperChain: [{ callerVariable: targetName, assignedFrom: call.expression.getText(sourceFileAst), aliasKind: "assignment", scopeRule: "same-file-source-order", returnedProperty: propertyName, importSource: resolved2.imp?.sourceFile, exportedSymbol: resolved2.imp?.exportedName, helperSourceFile: resolved2.helper.sourceFile, helperSourceLine: resolved2.helper.sourceLine }]
      });
    }
  }
  function recordDestructuredClassHelper(decl) {
    if (!ts5.isObjectBindingPattern(decl.name) || !decl.initializer) return;
    const call = unwrapCall(decl.initializer);
    if (!call || !ts5.isPropertyAccessExpression(call.expression)) return;
    const target = call.expression;
    if (target.expression.kind !== ts5.SyntaxKind.ThisKeyword) return;
    for (const el of decl.name.elements) {
      if (!ts5.isIdentifier(el.name)) continue;
      const propertyName = el.propertyName && ts5.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
      const helper = classHelpers.find(
        (h) => h.helperName === target.name.text && h.propertyName === propertyName
      );
      if (!helper) continue;
      out.push({
        variableName: el.name.text,
        ...helper.fact,
        sourceFile: normalizePath(filePath),
        sourceLine: lineOf4(sourceFileAst, decl),
        helperChain: [
          {
            callerVariable: el.name.text,
            className: helper.className,
            classHelper: helper.helperName,
            returnedProperty: helper.propertyName,
            helperVariable: helper.variableName,
            helperSourceFile: normalizePath(filePath),
            helperSourceLine: helper.sourceLine
          }
        ]
      });
    }
  }
  const events = [];
  function collectEvents(node) {
    if (ts5.isVariableDeclaration(node)) events.push({ pos: node.getStart(sourceFileAst), node });
    if (ts5.isBinaryExpression(node) && node.operatorToken.kind === ts5.SyntaxKind.EqualsToken)
      events.push({ pos: node.getStart(sourceFileAst), node });
    ts5.forEachChild(node, collectEvents);
  }
  collectEvents(sourceFileAst);
  events.sort((a, b) => a.pos - b.pos);
  for (const event of events) {
    if (ts5.isVariableDeclaration(event.node)) {
      const decl = event.node;
      await recordDestructuredHelper(decl);
      recordDestructuredClassHelper(decl);
      await recordVariable(decl);
      recordIdentityAlias(decl);
      if (ts5.isIdentifier(decl.name) && decl.initializer && ts5.isCallExpression(decl.initializer) && ts5.isPropertyAccessExpression(decl.initializer.expression) && decl.initializer.expression.name.text === "tx" && ts5.isIdentifier(decl.initializer.expression.expression)) {
        cloneAliasBinding(decl.name.text, decl.initializer.expression.expression.text, "transaction", decl);
      }
      continue;
    }
    const assignment = event.node;
    if (ts5.isIdentifier(assignment.left)) {
      const rhs = unwrapIdentityExpression(assignment.right);
      if (ts5.isIdentifier(rhs)) {
        cloneAliasBinding(assignment.left.text, rhs.text, "identity-assignment", assignment);
        continue;
      }
      await recordBindingFromExpression(assignment.left.text, assignment.right, assignment, "assignment");
      continue;
    }
    const left = ts5.isParenthesizedExpression(assignment.left) ? assignment.left.expression : assignment.left;
    if (ts5.isObjectLiteralExpression(left))
      await recordDestructuredAssignment(left, assignment.right, assignment);
  }
  return out;
}
function collectClassHelpers(sf) {
  const helpers = [];
  for (const stmt of sf.statements) {
    if (!ts5.isClassDeclaration(stmt) || !stmt.name) continue;
    for (const member of stmt.members) {
      let visit2 = function(node) {
        if (ts5.isVariableDeclaration(node) && ts5.isIdentifier(node.name) && node.initializer) {
          const fact = findConnectInExpression(node.initializer);
          if (fact) bindings.set(node.name.text, fact);
        }
        if (ts5.isReturnStatement(node) && node.expression && ts5.isObjectLiteralExpression(node.expression)) {
          for (const prop of node.expression.properties) {
            if (ts5.isShorthandPropertyAssignment(prop)) {
              const fact = bindings.get(prop.name.text);
              if (fact)
                helpers.push({
                  className,
                  helperName,
                  propertyName: prop.name.text,
                  variableName: prop.name.text,
                  fact,
                  sourceLine: lineOf4(sf, prop)
                });
            }
            if (ts5.isPropertyAssignment(prop) && ts5.isIdentifier(prop.initializer)) {
              const propertyName = ts5.isIdentifier(prop.name) || ts5.isStringLiteralLike(prop.name) ? prop.name.text : void 0;
              const fact = propertyName ? bindings.get(prop.initializer.text) : void 0;
              if (propertyName && fact)
                helpers.push({
                  className,
                  helperName,
                  propertyName,
                  variableName: prop.initializer.text,
                  fact,
                  sourceLine: lineOf4(sf, prop)
                });
            }
          }
        }
        ts5.forEachChild(node, visit2);
      };
      var visit = visit2;
      if (!ts5.isPropertyDeclaration(member) || !member.initializer) continue;
      if (!ts5.isIdentifier(member.name)) continue;
      const className = stmt.name.text;
      const helperName = member.name.text;
      const initializer = member.initializer;
      if (!ts5.isArrowFunction(initializer) && !ts5.isFunctionExpression(initializer))
        continue;
      const bindings = /* @__PURE__ */ new Map();
      visit2(initializer);
    }
  }
  return helpers;
}

// src/linker/dynamic-edge-resolver.ts
var PLACEHOLDER = /\$\{([^}]*)\}/g;
function applyVariables(template, vars) {
  return substituteVariables(template, vars).effective;
}
function extractPlaceholders(template) {
  return [...(template ?? "").matchAll(PLACEHOLDER)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
}
function substituteVariables(template, vars) {
  if (!template) return { placeholders: [], missing: [], supplied: [], changed: false };
  const placeholders2 = [...new Set(extractPlaceholders(template))];
  const supplied = placeholders2.filter((key) => Object.hasOwn(vars, key));
  const missing = placeholders2.filter((key) => !Object.hasOwn(vars, key));
  const effective = template.replace(PLACEHOLDER, (_m, key) => {
    const trimmed = key.trim();
    return Object.hasOwn(vars, trimmed) ? vars[trimmed] ?? "" : `\${${trimmed}}`;
  });
  return {
    original: template,
    effective,
    placeholders: placeholders2,
    missing,
    supplied,
    changed: effective !== template
  };
}

// src/linker/remote-query-target.ts
function buildRemoteQueryTarget(input) {
  const entity = typeof input.queryEntity === "string" && input.queryEntity.trim() ? input.queryEntity.trim() : void 0;
  const servicePath = input.servicePath?.trim();
  const prefix = servicePath ? `${servicePath}:` : "";
  const label = entity ? `Remote entity: ${prefix}${entity}` : "Remote query: unknown";
  return {
    toKind: entity ? "remote_entity" : "remote_query",
    toId: entity ? `${prefix}${entity}` : "unknown",
    label,
    evidence: {
      remoteQueryTarget: label,
      queryEntity: entity,
      queryTargetKind: entity ? "remote_entity" : "remote_query_unknown",
      queryEntityDynamic: entity ? void 0 : Boolean(input.isDynamic) || void 0,
      serviceAlias: input.serviceAlias,
      serviceAliasExpr: input.serviceAliasExpr,
      destination: input.destination,
      servicePath,
      parserWarning: entity ? input.parserWarning : input.parserWarning ?? { code: "query_entity_unknown", message: "Remote query entity is dynamic or unavailable" }
    }
  };
}

// src/linker/service-resolver.ts
function rows(db, operationPath, workspaceId) {
  const names = operationLookupNames(operationPath);
  return db.prepare(
    `SELECT o.id operationId,r.id repoId,r.name repoName,r.package_name packageName,s.service_name serviceName,s.qualified_name qualifiedName,s.service_path servicePath,o.operation_path operationPath,o.operation_name operationName,o.source_file sourceFile,o.source_line sourceLine,0 score,'' reasons
       FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id
       WHERE (? IS NULL OR r.workspace_id=?) AND (o.operation_path IN (?,?) OR o.operation_name IN (?,?)) ORDER BY r.name,s.service_path,o.operation_name`
  ).all(
    workspaceId,
    workspaceId,
    names.path,
    names.simplePath,
    names.name,
    names.simpleName
  );
}
function operationLookupNames(operationPath) {
  const name = operationPath.replace(/^\//, "");
  const simpleName = name.split(".").at(-1) ?? name;
  return { path: operationPath, simplePath: `/${simpleName}`, name, simpleName };
}
function operationMatches(candidate, operationPath) {
  if (!operationPath) return false;
  const names = operationLookupNames(operationPath);
  return candidate.operationPath === names.path || candidate.operationPath === names.simplePath || candidate.operationName === names.name || candidate.operationName === names.simpleName;
}
function resolveOperation(db, signals, workspaceId) {
  const missing = [signals.servicePath, signals.alias, signals.destination, signals.operationPath].flatMap((value) => [...(value ?? "").matchAll(/\$\{([^}]*)\}/g)].map((match) => (match[1] ?? "").trim())).filter(Boolean);
  if (missing.length > 0)
    return {
      status: "dynamic",
      candidates: signals.operationPath ? rows(db, signals.operationPath, workspaceId) : [],
      reasons: [...new Set(missing)].map((name) => `missing_variable:${name}`)
    };
  if (!signals.operationPath)
    return {
      status: "unresolved",
      candidates: [],
      reasons: ["missing_operation_path"]
    };
  const allCandidates = rows(db, signals.operationPath, workspaceId).map((c) => ({
    ...c,
    score: 0.2,
    reasons: ["operation_path_match"]
  }));
  let candidates = allCandidates.filter((c) => matchesLocalRepo(db, c.operationId, signals.repoId));
  if (candidates.length === 0 && signals.repoId !== void 0 && signals.serviceName) {
    candidates = implementationContextCandidates(db, allCandidates, signals.repoId, signals.serviceName);
    if (candidates.length === 0)
      return {
        status: "unresolved",
        candidates: allCandidates.filter((c) => serviceMatches(c, signals.serviceName)),
        reasons: allCandidates.some((c) => serviceMatches(c, signals.serviceName)) ? ["local_service_candidate_without_caller_ownership"] : ["no_operation_candidates"]
      };
  }
  if (candidates.length === 0)
    return {
      status: "unresolved",
      candidates: [],
      reasons: ["no_operation_candidates"]
    };
  const hasStrongSignal = Boolean(
    signals.servicePath || signals.serviceName || signals.alias || signals.destination || signals.hasExplicitOverride
  );
  for (const c of candidates) {
    if (signals.servicePath && c.servicePath === signals.servicePath) {
      c.score += 0.75;
      c.reasons.push("exact_service_path");
    }
    if (signals.servicePath && c.servicePath !== signals.servicePath) {
      c.score -= 0.1;
      c.reasons.push("service_path_mismatch");
    }
    if (signals.serviceName) {
      const simple = signals.serviceName.split(".").at(-1) ?? signals.serviceName;
      if (c.qualifiedName === signals.serviceName) {
        c.score += 0.8;
        c.reasons.push("exact_local_qualified_service_name");
      } else if (c.serviceName === signals.serviceName || c.serviceName === simple) {
        c.score += 0.75;
        c.reasons.push("exact_local_simple_service_name");
      } else if (c.servicePath === signals.serviceName || c.servicePath === `/${signals.serviceName}` || c.servicePath === `/${simple}`) {
        c.score += 0.7;
        c.reasons.push("exact_local_service_path");
      } else if (c.servicePath.endsWith(`/${simple}`)) {
        c.score += candidates.filter((candidate) => candidate.servicePath.endsWith(`/${simple}`)).length === 1 ? 0.65 : 0.2;
        c.reasons.push("suffix_local_service_path");
      } else c.reasons.push("local_service_name_mismatch");
    }
    if (signals.hasExplicitOverride) {
      c.score += 0.2;
      c.reasons.push(signals.repoId !== void 0 ? "explicit_local_service_call" : "explicit_dynamic_override");
    }
    if (signals.repoId !== void 0 && candidates.length === 1 && signals.serviceName && c.reasons.includes("local_service_name_mismatch") && operationMatches(c, signals.operationPath)) {
      c.score = Math.max(c.score, 0.9);
      c.reasons.push("same_repo_unique_operation_path_with_lookup_mismatch");
    }
  }
  for (const c of candidates) c.score = Math.max(0, Math.min(1, c.score));
  candidates.sort(
    (a, b) => b.score - a.score || a.repoName.localeCompare(b.repoName)
  );
  const best = candidates[0];
  const second = candidates[1];
  if (signals.isDynamic && !signals.hasExplicitOverride && !signals.servicePath)
    return {
      status: "dynamic",
      candidates,
      reasons: ["dynamic_target_without_override"]
    };
  if (!hasStrongSignal)
    return {
      status: candidates.length > 1 ? "ambiguous" : "unresolved",
      candidates,
      reasons: ["operation_path_only_has_no_strong_target_signal"]
    };
  if (best && best.score >= 0.9 && (best.servicePath === signals.servicePath || Boolean(signals.serviceName && (!best.reasons.includes("local_service_name_mismatch") || best.reasons.includes("same_repo_unique_operation_path_with_lookup_mismatch")))) && operationMatches(best, signals.operationPath) && (!second || best.score - second.score >= 0.25))
    return {
      status: "resolved",
      target: best,
      candidates,
      reasons: best.reasons
    };
  return {
    status: candidates.length > 1 ? "ambiguous" : "unresolved",
    candidates,
    reasons: ["candidate_score_below_resolution_threshold"]
  };
}
function serviceMatches(candidate, serviceName) {
  if (!serviceName) return false;
  const simple = serviceName.split(".").at(-1) ?? serviceName;
  return candidate.qualifiedName === serviceName || candidate.serviceName === serviceName || candidate.serviceName === simple || candidate.servicePath === serviceName || candidate.servicePath === `/${serviceName}` || candidate.servicePath === `/${simple}` || candidate.servicePath.endsWith(`/${simple}`);
}
function implementationContextCandidates(db, candidates, callerRepoId, serviceName) {
  const matching = candidates.filter((candidate) => serviceMatches(candidate, serviceName));
  const owned = matching.map((candidate) => ownershipReason(db, candidate, callerRepoId)).filter((item) => Boolean(item));
  if (owned.length === 0) return [];
  const direct = owned.filter((item) => item.reason !== "caller_depends_on_model_package");
  const chosen = direct.length > 0 ? direct : owned.length === 1 ? owned : [];
  return chosen.map((item) => ({ ...item.candidate, score: 0.95, reasons: [...item.candidate.reasons, "implementation_context_caller_ownership", item.reason] }));
}
function ownershipReason(db, candidate, callerRepoId) {
  const edge = db.prepare("SELECT status,evidence_json,to_id FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND from_kind='operation' AND from_id=? ORDER BY CASE status WHEN 'resolved' THEN 0 WHEN 'ambiguous' THEN 1 ELSE 2 END LIMIT 1").get(String(candidate.operationId));
  if (edge?.status === "resolved") {
    const row = db.prepare("SELECT hc.repo_id repoId FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id WHERE hm.id=?").get(edge.to_id);
    if (row?.repoId === callerRepoId) return { candidate, reason: "resolved_implementation_handler_repo_matches_caller" };
  }
  if (edge?.evidence_json) {
    const evidence = JSON.parse(edge.evidence_json);
    const hit = evidence.candidates?.find((item) => item.accepted && (Number(item.handlerPackage?.id) === callerRepoId || Number(item.applicationPackage?.id) === callerRepoId));
    if (hit) return { candidate, reason: edge.status === "ambiguous" ? "ambiguous_implementation_candidate_repo_matches_caller" : "registration_package_matches_caller" };
  }
  const dep = db.prepare("SELECT 1 FROM graph_edges WHERE edge_type='REPO_IMPORTS_HELPER_PACKAGE' AND status='resolved' AND from_kind='repo' AND from_id=? AND to_id=?").get(String(callerRepoId), String(candidate.repoId));
  if (dep) return { candidate, reason: "caller_depends_on_model_package" };
  return void 0;
}
function matchesLocalRepo(db, operationId, repoId) {
  if (repoId === void 0) return true;
  const row = db.prepare("SELECT s.repo_id repoId FROM cds_operations o JOIN cds_services s ON s.id=o.service_id WHERE o.id=?").get(operationId);
  return row?.repoId === repoId;
}

// src/linker/helper-package-linker.ts
function normalizeName(value) {
  return value.toLowerCase().replace(/^@[^/]+\//, "").replace(/[^a-z0-9]+/g, "");
}
function candidatesForDependency(repos, dep, sourceId) {
  const exact = repos.filter((repo) => repo.id !== sourceId && repo.package_name === dep);
  if (exact.length > 0) return { candidates: exact, strategy: "exact_package_name" };
  const normalized = normalizeName(dep);
  return { candidates: repos.filter((repo) => repo.id !== sourceId && normalizeName(repo.name) === normalized), strategy: "normalized_directory" };
}
function linkHelperPackages(db, workspaceId, generation) {
  const repos = db.prepare("SELECT id,name,package_name,dependencies_json FROM repositories WHERE workspace_id=?").all(workspaceId);
  const summary = { edgeCount: 0, resolvedCount: 0, ambiguousCount: 0 };
  for (const repo of repos) {
    const deps = JSON.parse(repo.dependencies_json);
    for (const dep of Object.keys(deps)) {
      const result = candidatesForDependency(repos, dep, repo.id);
      if (result.candidates.length === 0) continue;
      const status = result.candidates.length === 1 ? "resolved" : "ambiguous";
      const helper = status === "resolved" ? result.candidates[0] : void 0;
      db.prepare("INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
        workspaceId,
        "REPO_IMPORTS_HELPER_PACKAGE",
        status,
        "repo",
        String(repo.id),
        helper ? "repo" : "repo_candidates",
        helper ? String(helper.id) : result.candidates.map((candidate) => candidate.id).join(","),
        helper ? 1 : 0.5,
        JSON.stringify({ dependency: dep, candidates: result.candidates.map((candidate) => ({ id: candidate.id, name: candidate.name, packageName: candidate.package_name })), match: result.strategy }),
        0,
        helper ? null : "Ambiguous dependency package candidates",
        generation
      );
      summary.edgeCount += 1;
      if (helper) summary.resolvedCount += 1;
      else summary.ambiguousCount += 1;
    }
  }
  return summary;
}

// src/linker/operation-decorator-normalizer.ts
function lowerFirst(value) {
  return value ? `${value[0]?.toLowerCase() ?? ""}${value.slice(1)}` : value;
}
function normalizedOperationName(value) {
  return value.replace(/^\//, "");
}
function clean(value) {
  return value.replace(/^[`'"]|[`'"]$/g, "");
}
function generatedFromConstantName(value) {
  for (const prefix of ["Action", "Func"]) {
    if (value.startsWith(prefix) && value.length > prefix.length && /^[A-Z]/.test(value.slice(prefix.length))) return lowerFirst(value.slice(prefix.length));
  }
  return void 0;
}
function resolved(value, raw) {
  const literal = clean(value);
  const generated = generatedFromConstantName(literal);
  return { status: "resolved", operationName: generated ?? normalizedOperationName(literal), raw };
}
function normalizeDecoratorOperationSignal(value, raw, candidateOperation) {
  if (value) return resolved(value, raw);
  if (!raw || raw.trim().length === 0) return { status: "none", raw };
  const expression = raw.trim();
  const nameMatch = /(?:^|\.)(Action[A-Z][\w$]*|Func[A-Z][\w$]*)\.name$/.exec(expression);
  if (nameMatch?.[1]) return resolved(nameMatch[1], expression);
  const stringMatch = /^String\(([A-Za-z_$][\w$]*)\)$/.exec(expression);
  if (stringMatch?.[1]) {
    const identifier = stringMatch[1];
    const generated = generatedFromConstantName(identifier);
    const normalizedCandidate = candidateOperation ? normalizedOperationName(candidateOperation) : void 0;
    if (generated) return { status: "resolved", operationName: generated, raw: expression };
    if (normalizedCandidate && identifier === normalizedCandidate) return { status: "resolved", operationName: identifier, raw: expression };
    return { status: "unsupported", raw: expression, reason: "string_wrapper_identifier_not_resolved" };
  }
  if (/^[`'"]/.test(expression) && !/[`'"]$/.test(expression)) return { status: "malformed", raw: expression, reason: "unterminated_literal" };
  return { status: "unsupported", raw: expression, reason: "unsupported_decorator_expression" };
}

// src/linker/cross-repo-linker.ts
function linkWorkspace(db, workspaceId, vars = {}) {
  return db.transaction(() => {
    const generation = nextGraphGeneration(db, workspaceId);
    db.prepare("DELETE FROM graph_edges WHERE workspace_id=?").run(workspaceId);
    const deps = linkHelperPackages(db, workspaceId, generation);
    const impl = linkImplementations(db, workspaceId, generation);
    const callSummary = linkCalls(db, workspaceId, vars, generation);
    db.prepare("UPDATE repositories SET graph_generation=?, graph_stale_reason=NULL, graph_stale_at=NULL WHERE workspace_id=?").run(generation, workspaceId);
    return { ...callSummary, edgeCount: deps.edgeCount + callSummary.edgeCount + impl.edgeCount, dependencyResolvedCount: deps.resolvedCount, dependencyAmbiguousCount: deps.ambiguousCount, implementationResolvedCount: impl.resolvedCount, implementationAmbiguousCount: impl.ambiguousCount, implementationUnresolvedCount: impl.unresolvedCount };
  });
}
function nextGraphGeneration(db, workspaceId) {
  const row = db.prepare("SELECT COALESCE(MAX(graph_generation),0) generation FROM repositories WHERE workspace_id=?").get(workspaceId);
  return Number(row?.generation ?? 0) + 1;
}
function linkCalls(db, workspaceId, vars, generation) {
  let edgeCount = 0;
  let unresolvedCount = 0;
  let resolvedCount = 0;
  let remoteResolvedCount = 0;
  let localResolvedCount = 0;
  let ambiguousCount = 0;
  let dynamicCount = 0;
  let terminalCount = 0;
  const calls = db.prepare(`SELECT c.*,r.name repoName,b.alias,b.alias_expr aliasExpr,b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,b.is_dynamic isDynamic,b.placeholders_json placeholdersJson,b.helper_chain_json helperChainJson,req.service_path requireServicePath,req.destination requireDestination FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id LEFT JOIN service_bindings b ON b.id=c.service_binding_id LEFT JOIN cds_requires req ON req.repo_id=c.repo_id AND req.alias=b.alias WHERE r.workspace_id=?`).all(workspaceId);
  for (const call of calls) {
    const result = insertCallEdge(db, workspaceId, call, vars, generation);
    edgeCount += 1;
    resolvedCount += result.status === "resolved" ? 1 : 0;
    remoteResolvedCount += result.status === "resolved" && result.callType !== "local_service_call" ? 1 : 0;
    localResolvedCount += result.status === "resolved" && result.callType === "local_service_call" ? 1 : 0;
    unresolvedCount += result.status === "unresolved" ? 1 : 0;
    ambiguousCount += result.status === "ambiguous" ? 1 : 0;
    dynamicCount += result.status === "dynamic" ? 1 : 0;
    terminalCount += result.status === "terminal" ? 1 : 0;
  }
  return { edgeCount, unresolvedCount, resolvedCount, remoteResolvedCount, localResolvedCount, ambiguousCount, dynamicCount, terminalCount };
}
function insertCallEdge(db, workspaceId, call, vars, generation) {
  const callType = String(call.call_type);
  const rawOp = applyVariables(String(call.operation_path_expr ?? ""), vars);
  const intent = classifyODataPathIntent(rawOp, call.method);
  const isEntityQueryIntent = ["entity_query", "entity_key_read", "entity_navigation_query"].includes(intent.kind);
  const resolutionRawOp = callType === "remote_query" && isEntityQueryIntent ? intent.pathWithoutQuery : rawOp;
  const normalized = normalizeODataOperationInvocationPath(resolutionRawOp);
  const op = normalized?.normalizedOperationPath ?? resolutionRawOp;
  const servicePath = applyVariables(call.servicePathExpr ?? call.requireServicePath, vars);
  const destination = call.destinationExpr ?? call.requireDestination;
  const isDynamic = Boolean(Number(call.isDynamic ?? 0));
  const isRemoteEntityCall = callType.startsWith("remote_entity_");
  const operationLikeRemoteEntity = isRemoteEntityCall && Boolean(op) && !["entity_media", "entity_delete", "entity_key_read", "entity_navigation_query"].includes(intent.kind);
  const isOperationCall = operationLikeRemoteEntity || (callType === "remote_action" || callType === "local_service_call" || callType === "remote_query" && Boolean(op));
  const resolution = isOperationCall ? resolveOperation(db, { servicePath, operationPath: op, serviceName: call.local_service_name, repoId: callType === "local_service_call" ? Number(call.repo_id) : void 0, alias: applyVariables(call.aliasExpr ?? call.alias, vars), destination: destination ? applyVariables(destination, vars) : void 0, isDynamic, hasExplicitOverride: Object.keys(vars).length > 0 || callType === "local_service_call" }, workspaceId) : { status: "unresolved", candidates: [], reasons: [] };
  const evidence = callEvidence(call, resolution, servicePath, op, destination ? applyVariables(destination, vars) : void 0, normalized, intent);
  if (isRemoteEntityCall && (resolution.target || resolution.candidates.length > 0 || resolution.status === "dynamic")) {
    if (resolution.target) {
      db.prepare("INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(workspaceId, "REMOTE_CALL_RESOLVES_TO_OPERATION", "resolved", "call", String(call.id), "operation", String(resolution.target.operationId), resolution.target.score, JSON.stringify({ ...evidence, operationEntityPrecedence: "indexed_operation_over_parser_entity" }), 0, generation);
      return { status: "resolved", callType };
    }
    const status2 = resolution.status === "dynamic" ? "dynamic" : resolution.status === "ambiguous" ? "ambiguous" : "unresolved";
    db.prepare("INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(workspaceId, status2 === "dynamic" ? "DYNAMIC_EDGE_CANDIDATE" : "UNRESOLVED_EDGE", status2, "call", String(call.id), "operation_candidate", op ? `Remote action: ${op}` : "Remote action: unknown path", Number(call.confidence ?? 0.2), JSON.stringify({ ...evidence, operationEntityPrecedence: "parser_entity_with_indexed_operation_candidates" }), status2 === "dynamic" ? 1 : 0, unresolvedOperationReason(resolution), generation);
    return { status: status2, callType };
  }
  if (isRemoteEntityCall) {
    const target = buildRemoteQueryTarget({ queryEntity: intent.entitySegment ?? call.query_entity, servicePath, serviceAlias: call.alias, serviceAliasExpr: call.aliasExpr, destination: destination ? applyVariables(destination, vars) : void 0, isDynamic, parserWarning: evidence.parserWarning });
    const entityKind = callType.replace("remote_entity_", "remote_entity_");
    db.prepare("INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(workspaceId, "HANDLER_ACCESSES_REMOTE_ENTITY", "terminal", "call", String(call.id), target.toKind, target.toId, Number(call.confidence ?? 0.5), JSON.stringify({ ...evidence, ...target.evidence, remoteEntityAccess: entityKind }), 0, generation);
    return { status: "terminal", callType };
  }
  if (callType === "remote_query" && (isEntityQueryIntent || !op) && !resolution.target) {
    const target = buildRemoteQueryTarget({ queryEntity: call.query_entity, servicePath, serviceAlias: call.alias, serviceAliasExpr: call.aliasExpr, destination: destination ? applyVariables(destination, vars) : void 0, isDynamic, parserWarning: evidence.parserWarning });
    db.prepare("INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(workspaceId, "HANDLER_RUNS_REMOTE_QUERY", "terminal", "call", String(call.id), target.toKind, target.toId, Number(call.confidence ?? 0.5), JSON.stringify({ ...evidence, ...target.evidence }), 0, generation);
    return { status: "terminal", callType };
  }
  if (callType === "local_service_call" && call.unresolved_reason === "transport_client_method" && !resolution.target && resolution.candidates.length === 0) {
    db.prepare("INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(workspaceId, "HANDLER_CALLS_TRANSPORT_METHOD", "terminal", "call", String(call.id), "transport_method", String(op || "transport_client_method"), Number(call.confidence ?? 0.5), JSON.stringify({ ...evidence, classification: "transport_client_method" }), 0, generation);
    return { status: "terminal", callType };
  }
  if (resolution.target) {
    db.prepare("INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(workspaceId, callType === "local_service_call" ? "LOCAL_CALL_RESOLVES_TO_OPERATION" : "REMOTE_CALL_RESOLVES_TO_OPERATION", "resolved", "call", String(call.id), "operation", String(resolution.target.operationId), resolution.target.score, JSON.stringify(evidence), 0, generation);
    return { status: "resolved", callType };
  }
  const edgeType = callType === "local_db_query" ? "HANDLER_RUNS_DB_QUERY" : callType === "external_http" ? "HANDLER_CALLS_EXTERNAL_HTTP" : callType === "async_emit" ? "HANDLER_EMITS_EVENT" : callType === "async_subscribe" ? "EVENT_CONSUMED_BY_HANDLER" : resolution.status === "dynamic" ? "DYNAMIC_EDGE_CANDIDATE" : "UNRESOLVED_EDGE";
  const status = edgeType === "DYNAMIC_EDGE_CANDIDATE" ? "dynamic" : resolution.status === "ambiguous" ? "ambiguous" : edgeType === "UNRESOLVED_EDGE" ? "unresolved" : "terminal";
  const unresolvedReason = status === "terminal" ? null : String(call.unresolved_reason ?? unresolvedOperationReason(resolution));
  const externalTarget = callType === "external_http" ? externalHttpTarget(call) : void 0;
  const targetKind = callType === "local_db_query" ? "db_entity" : callType.startsWith("async_") ? "event" : callType === "external_http" ? externalTarget?.toKind ?? "external_endpoint" : "operation_candidate";
  const targetId = callType === "local_db_query" ? String(call.query_entity ?? "unknown") : callType === "remote_action" ? op ? `Remote action: ${op}` : call.unresolved_reason === "dynamic_operation_path_identifier" ? "Remote action: dynamic path" : "Remote action: unknown path" : callType === "external_http" ? String(externalTarget?.toId ?? "unknown") : String(call.event_name_expr ?? op ?? "unknown");
  const graphLevelDynamic = edgeType === "DYNAMIC_EDGE_CANDIDATE" && resolution.status === "dynamic";
  const finalEvidence = externalTarget ? { ...evidence, externalTarget } : evidence;
  db.prepare("INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(workspaceId, edgeType, status, "call", String(call.id), targetKind, targetId, Number(call.confidence ?? 0.2), JSON.stringify(finalEvidence), graphLevelDynamic ? 1 : 0, unresolvedReason, generation);
  return { status, callType };
}
function unresolvedOperationReason(resolution) {
  if (resolution.status === "dynamic") return `Dynamic target requires runtime variable overrides: ${(resolution.reasons.length ? resolution.reasons : ["missing runtime variables"]).join(", ")}`;
  if (resolution.candidates.length === 0) return "No indexed target operation matched";
  if (resolution.reasons.includes("operation_path_only_has_no_strong_target_signal")) return "Operation candidates found but no strong service signal is available";
  if (resolution.reasons.includes("candidate_score_below_resolution_threshold")) return "Operation candidates found but resolution score is below threshold";
  if (resolution.status === "ambiguous") return "Ambiguous operation candidates require a strong service signal";
  return "Operation candidates found but resolution could not select a target";
}
function parseJson(value) {
  if (!value) return void 0;
  try {
    return JSON.parse(String(value));
  } catch {
    return void 0;
  }
}
function objectJson(value) {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
}
function callEvidence(call, resolution, servicePath, op, destination, normalized, odataPathIntent) {
  const bindingHasDynamicExpression = Boolean(Number(call.isDynamic ?? 0));
  return { sourceFile: call.source_file, sourceLine: call.source_line, file: call.source_file, line: call.source_line, callId: call.id, repo: call.repoName, serviceAlias: call.alias, serviceAliasExpr: call.aliasExpr, destination, servicePath, operationPath: op, rawOperationPath: normalized?.wasInvocation ? normalized.rawOperationPath : odataPathIntent?.rawPath, normalizedOperationPath: normalized?.wasInvocation ? normalized.normalizedOperationPath : void 0, invocationArgumentPlaceholderKeys: normalized?.invocationArgumentPlaceholderKeys.length ? normalized.invocationArgumentPlaceholderKeys : void 0, odataOperationNormalizationReason: normalized?.normalizationReason, odataOperationNormalizationRejectedReason: normalized?.normalizationRejectedReason, localServiceName: call.local_service_name, localServiceLookup: call.local_service_lookup, aliasChain: parseJson(call.alias_chain_json), transport: call.call_type === "local_service_call" ? "local" : void 0, targetRepo: resolution.target?.repoName, targetServicePath: resolution.target?.servicePath, targetOperationPath: resolution.target?.operationPath, targetOperation: resolution.target?.operationName, helperChain: parseJson(call.helperChainJson), candidates: resolution.candidates, candidateCount: resolution.candidates.length, resolutionStatus: resolution.status, resolutionReasons: resolution.reasons, odataPathIntent, queryStringPresent: odataPathIntent?.hasQueryString || void 0, queryPlaceholderKeys: odataPathIntent?.placeholderKeys.length ? odataPathIntent.placeholderKeys : void 0, bindingHasDynamicExpression: bindingHasDynamicExpression || void 0, outboundEvidence: objectJson(call.evidence_json), analysisCompleteness: call.unresolved_reason ? "partial" : "complete", parserWarning: call.unresolved_reason ? { code: "parser_warning", message: call.unresolved_reason } : void 0 };
}
function linkImplementations(db, workspaceId, generation) {
  const operations = db.prepare(`SELECT o.id operationId,o.operation_path operationPath,o.operation_name operationName,s.service_path servicePath,s.repo_id modelRepoId,r.name modelRepo,r.package_name modelPackage,r.kind modelKind FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id WHERE r.workspace_id=?`).all(workspaceId);
  let edgeCount = 0;
  let resolvedCount = 0;
  let ambiguousCount = 0;
  let unresolvedCount = 0;
  for (const operation of operations) {
    const candidates = rankedImplementationCandidates(db, workspaceId, operation);
    if (candidates.length === 0) continue;
    const accepted = candidates.filter((candidate) => candidate.accepted);
    const topScore = accepted[0]?.score ?? 0;
    const winners = accepted.filter((candidate) => candidate.score === topScore);
    const unique = winners.length === 1 ? winners[0] : void 0;
    const evidence = {
      servicePath: operation.servicePath,
      operationPath: operation.operationPath,
      operationName: operation.operationName,
      modelPackage: { id: operation.modelRepoId, name: operation.modelRepo, packageName: operation.modelPackage },
      candidates: candidates.map((candidate, index) => candidateEvidence(candidate, index + 1))
    };
    if (accepted.length === 0) {
      db.prepare("INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(workspaceId, "OPERATION_IMPLEMENTED_BY_HANDLER", "unresolved", "operation", graphId(operation.operationId), "handler_method_candidates", candidates.map((row) => graphId(row.methodId)).join(","), 0, JSON.stringify(evidence), 0, "No implementation candidate passed policy", generation);
      edgeCount += 1;
      unresolvedCount += 1;
      continue;
    }
    db.prepare("INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(workspaceId, "OPERATION_IMPLEMENTED_BY_HANDLER", unique ? "resolved" : "ambiguous", "operation", graphId(operation.operationId), unique ? "handler_method" : "handler_method_candidates", unique ? graphId(unique.methodId) : winners.map((row) => graphId(row.methodId)).join(","), unique ? 0.95 : 0.5, JSON.stringify(evidence), 0, unique ? null : "Ambiguous registered handler implementation candidates", generation);
    edgeCount += 1;
    if (unique) resolvedCount += 1;
    else ambiguousCount += 1;
  }
  return { edgeCount, resolvedCount, ambiguousCount, unresolvedCount };
}
function rankedImplementationCandidates(db, workspaceId, operation) {
  const rows2 = implementationCandidates(db, workspaceId, operation);
  return deduplicateCandidates(rows2.map((row) => scoreImplementationCandidate(row, operation))).sort((a, b) => b.score - a.score || String(a.className).localeCompare(String(b.className)) || a.methodId - b.methodId);
}
function deduplicateCandidates(rows2) {
  const merged = /* @__PURE__ */ new Map();
  for (const row of rows2) {
    const key = [row.methodId, row.classId, row.handlerRepoId].join(":");
    const registration = { file: row.registrationFile, line: row.registrationLine, kind: row.registrationKind, importSource: row.importSource };
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row, registrations: [registration] });
      continue;
    }
    existing.registrations = uniqueRegistrations([...existing.registrations ?? [], registration]);
    existing.score = Math.max(existing.score, row.score);
    existing.accepted = existing.accepted || row.accepted;
    existing.acceptedReasons = [.../* @__PURE__ */ new Set([...existing.acceptedReasons, ...row.acceptedReasons])];
    existing.rejectedReasons = [.../* @__PURE__ */ new Set([...existing.rejectedReasons, ...row.rejectedReasons])];
  }
  return [...merged.values()];
}
function uniqueRegistrations(rows2) {
  const seen = /* @__PURE__ */ new Set();
  return rows2.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function implementationCandidates(db, workspaceId, operation) {
  const modelRepoGraphId = graphId(operation.modelRepoId);
  return db.prepare(`SELECT DISTINCT
      hm.id methodId,
      hm.method_name methodName,
      hm.decorator_value decoratorValue,
      hm.decorator_raw_expression decoratorRawExpression,
      hc.id classId,
      hc.class_name className,
      hc.source_file sourceFile,
      hc.source_line sourceLine,
      hr.repo_id applicationRepoId,
      hr.registration_file registrationFile,
      hr.registration_line registrationLine,
      hr.registration_kind registrationKind,
      hr.import_source importSource,
      handlerRepo.id handlerRepoId,
      handlerRepo.name handlerRepo,
      handlerRepo.package_name handlerPackage,
      appRepo.name applicationRepo,
      appRepo.package_name applicationPackage,
      ? modelRepoId,
      ? modelRepo,
      ? modelPackage,
      ? modelKind,
      ? servicePath,
      ? operationPath,
      ? operationName,
      CASE WHEN appRepo.id=? THEN 1 ELSE 0 END modelIsApplicationRepo,
      CASE WHEN handlerRepo.id=? THEN 1 ELSE 0 END modelIsHandlerRepo,
      CASE WHEN appRepo.id=handlerRepo.id THEN 1 ELSE 0 END sameRepoRegistration,
      CASE WHEN EXISTS (SELECT 1 FROM cds_services localService WHERE localService.repo_id=appRepo.id AND localService.service_path=?) THEN 1 ELSE 0 END localServicePathMatch,
      CASE WHEN EXISTS (SELECT 1 FROM cds_services localService WHERE localService.repo_id=appRepo.id) THEN 1 ELSE 0 END applicationHasLocalServices,
      CASE WHEN EXISTS (SELECT 1 FROM handler_registrations localReg JOIN handler_classes localClass ON (localClass.id=localReg.handler_class_id OR localClass.class_name=localReg.class_name) JOIN handler_methods localMethod ON localMethod.handler_class_id=localClass.id WHERE localReg.repo_id=appRepo.id AND (localMethod.decorator_value=? OR localMethod.decorator_value=? OR localMethod.method_name=? OR localMethod.decorator_raw_expression LIKE ?)) THEN 1 ELSE 0 END applicationHasLocalRegistrationForOperation,
      CASE WHEN EXISTS (SELECT 1 FROM graph_edges dep WHERE dep.edge_type='REPO_IMPORTS_HELPER_PACKAGE' AND dep.status='resolved' AND dep.from_kind='repo' AND dep.from_id=CAST(appRepo.id AS TEXT) AND dep.to_id=?) THEN 1 ELSE 0 END appDependsOnModel,
      CASE WHEN EXISTS (SELECT 1 FROM graph_edges dep WHERE dep.edge_type='REPO_IMPORTS_HELPER_PACKAGE' AND dep.status='resolved' AND dep.from_kind='repo' AND dep.from_id=CAST(appRepo.id AS TEXT) AND dep.to_id=CAST(handlerRepo.id AS TEXT)) THEN 1 ELSE 0 END appDependsOnHandler,
      CASE WHEN EXISTS (SELECT 1 FROM graph_edges dep WHERE dep.edge_type='REPO_IMPORTS_HELPER_PACKAGE' AND dep.status='resolved' AND dep.from_kind='repo' AND dep.from_id=CAST(handlerRepo.id AS TEXT) AND dep.to_id=?) THEN 1 ELSE 0 END handlerDependsOnModel
    FROM handler_methods hm
    JOIN handler_classes hc ON hc.id=hm.handler_class_id
    JOIN repositories handlerRepo ON handlerRepo.id=hc.repo_id
    JOIN handler_registrations hr ON (hr.handler_class_id=hc.id OR (hr.class_name=hc.class_name AND (hr.repo_id=hc.repo_id OR hr.import_source IS NOT NULL)))
    JOIN repositories appRepo ON appRepo.id=hr.repo_id
    WHERE appRepo.workspace_id=?
      AND (hm.decorator_value=? OR hm.decorator_value=? OR hm.method_name=? OR hm.decorator_raw_expression LIKE ?)`).all(
    operation.modelRepoId,
    operation.modelRepo,
    operation.modelPackage,
    operation.modelKind,
    operation.servicePath,
    operation.operationPath,
    operation.operationName,
    operation.modelRepoId,
    operation.modelRepoId,
    operation.servicePath,
    normalizedOperation(String(operation.operationPath ?? "")),
    operation.operationName,
    operation.operationName,
    `%${upperFirst(normalizedOperation(String(operation.operationPath ?? operation.operationName ?? "")))}%`,
    modelRepoGraphId,
    modelRepoGraphId,
    workspaceId,
    normalizedOperation(String(operation.operationPath ?? "")),
    operation.operationName,
    operation.operationName,
    `%${upperFirst(normalizedOperation(String(operation.operationPath ?? operation.operationName ?? "")))}%`
  );
}
function scoreImplementationCandidate(row, operation) {
  const acceptedReasons = [];
  const rejectedReasons = [];
  let score = 0;
  const modelIsApplicationRepo = flag(row.modelIsApplicationRepo);
  const modelIsHandlerRepo = flag(row.modelIsHandlerRepo);
  const localServicePathMatch = flag(row.localServicePathMatch);
  const applicationHasLocalServices = flag(row.applicationHasLocalServices);
  const appDependsOnModel = flag(row.appDependsOnModel);
  const applicationHasLocalRegistrationForOperation = flag(row.applicationHasLocalRegistrationForOperation);
  const appDependsOnHandler = flag(row.appDependsOnHandler);
  const handlerDependsOnModel = flag(row.handlerDependsOnModel);
  const importSource = typeof row.importSource === "string" && row.importSource.length > 0;
  const sameRepoRegistration = flag(row.sameRepoRegistration);
  const modelOriented = row.modelKind === "cap-db-model" || !applicationHasLocalRegistrationForOperation;
  const methodSignal = implementationMethodSignal(row, operation);
  const methodMatches = methodSignal.matches;
  acceptedReasons.push(...methodSignal.acceptedReasons);
  rejectedReasons.push(...methodSignal.rejectedReasons);
  const registeredAndLinked = sameRepoRegistration && importSource;
  const helperOwned = modelOriented && methodMatches && registeredAndLinked && sameRepoRegistration && !applicationHasLocalServices && !modelIsApplicationRepo && !modelIsHandlerRepo && !localServicePathMatch && !appDependsOnModel && !appDependsOnHandler && !handlerDependsOnModel;
  if (modelIsApplicationRepo) {
    score += 100;
    acceptedReasons.push("model package equals registration package");
  }
  if (modelIsHandlerRepo) {
    score += 100;
    acceptedReasons.push("model package equals handler package");
  }
  if (localServicePathMatch) {
    score += 80;
    acceptedReasons.push("registration package contains exact local service path");
  } else if (applicationHasLocalServices && !appDependsOnModel && !modelIsApplicationRepo) {
    rejectedReasons.push(`registration package has local services but none match ${String(operation.servicePath ?? "")}`);
  }
  if (appDependsOnModel) {
    score += 70;
    acceptedReasons.push("registration package depends on model package");
  }
  if (appDependsOnHandler) {
    score += 30;
    acceptedReasons.push("registration package depends on handler package");
  }
  if (handlerDependsOnModel) {
    score += 20;
    acceptedReasons.push("handler package depends on model package");
  }
  if (helperOwned) {
    score += 60;
    acceptedReasons.push("unique registered helper implementation for model-only operation");
  }
  if (importSource) {
    score += 10;
    acceptedReasons.push("registration imports handler class");
  }
  const hasOwnership = modelIsApplicationRepo || modelIsHandlerRepo;
  const hasCrossPackage = appDependsOnModel && (modelIsHandlerRepo || appDependsOnHandler || !importSource);
  const contradicted = applicationHasLocalServices && !localServicePathMatch && !appDependsOnModel && !hasOwnership;
  if (!hasOwnership && !localServicePathMatch && !hasCrossPackage && !helperOwned) rejectedReasons.push("missing direct ownership, exact local service path, or validated cross-package dependency evidence");
  const accepted = methodMatches && !methodSignal.contradicted && !contradicted && (hasOwnership || localServicePathMatch || hasCrossPackage || handlerDependsOnModel || helperOwned);
  if (!accepted && rejectedReasons.length === 0) rejectedReasons.push("candidate did not meet implementation ownership policy");
  return { ...row, methodId: Number(row.methodId), score, accepted, acceptedReasons, rejectedReasons };
}
function candidateEvidence(candidate, rank) {
  return {
    rank,
    score: candidate.score,
    accepted: candidate.accepted,
    acceptedReasons: candidate.acceptedReasons,
    rejectedReasons: candidate.rejectedReasons,
    methodId: candidate.methodId,
    classId: candidate.classId,
    className: candidate.className,
    sourceFile: candidate.sourceFile,
    sourceLine: candidate.sourceLine,
    registration: { file: candidate.registrationFile, line: candidate.registrationLine, kind: candidate.registrationKind, importSource: candidate.importSource },
    registrations: candidate.registrations ?? [],
    applicationPackage: { id: candidate.applicationRepoId, name: candidate.applicationRepo, packageName: candidate.applicationPackage },
    handlerPackage: { id: candidate.handlerRepoId, name: candidate.handlerRepo, packageName: candidate.handlerPackage },
    modelPackage: { id: candidate.modelRepoId, name: candidate.modelRepo, packageName: candidate.modelPackage },
    servicePath: candidate.servicePath,
    operationPath: candidate.operationPath,
    operationName: candidate.operationName,
    signals: {
      directOwnership: { modelIsApplicationRepo: flag(candidate.modelIsApplicationRepo), modelIsHandlerRepo: flag(candidate.modelIsHandlerRepo) },
      localServicePathMatch: flag(candidate.localServicePathMatch),
      applicationHasLocalServices: flag(candidate.applicationHasLocalServices),
      applicationHasLocalRegistrationForOperation: flag(candidate.applicationHasLocalRegistrationForOperation),
      appDependsOnModel: flag(candidate.appDependsOnModel),
      appDependsOnHandler: flag(candidate.appDependsOnHandler),
      handlerDependsOnModel: flag(candidate.handlerDependsOnModel),
      sameRepoRegistration: flag(candidate.sameRepoRegistration)
    }
  };
}
function implementationMethodSignal(row, operation) {
  const op = normalizedOperationName(String(operation.operationPath ?? operation.operationName ?? ""));
  const decorator = normalizeDecoratorOperationSignal(typeof row.decoratorValue === "string" ? row.decoratorValue : void 0, typeof row.decoratorRawExpression === "string" ? row.decoratorRawExpression : void 0, op);
  if (decorator.status === "resolved" && decorator.operationName === op) return { matches: true, contradicted: false, acceptedReasons: ["decorator targets operation"], rejectedReasons: [] };
  if (decorator.status === "resolved" && decorator.operationName !== op) return { matches: false, contradicted: true, acceptedReasons: [], rejectedReasons: ["method_name_matches_but_decorator_targets_different_operation"] };
  if (String(row.methodName ?? "") === op) return { matches: true, contradicted: false, acceptedReasons: ["method name fallback matched operation"], rejectedReasons: [] };
  return { matches: false, contradicted: false, acceptedReasons: [], rejectedReasons: ["method name does not match operation"] };
}
function upperFirst(value) {
  return value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}
function flag(value) {
  return Boolean(Number(value ?? 0));
}
function graphId(value) {
  return String(value);
}
function normalizedOperation(value) {
  return value.startsWith("/") ? value.slice(1) : value;
}

// src/trace/trace-engine.ts
function normalizeOperation(value) {
  if (!value) return void 0;
  return value.startsWith("/") ? value.slice(1) : value;
}
function positiveDepth(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 25;
}
function operationStartScope(db, repoId, start) {
  const requested = normalizeOperation(start.operationPath ?? start.operation);
  if (!requested) return void 0;
  const rows2 = db.prepare(`SELECT o.id operationId,o.operation_name operationName,o.operation_path operationPath,s.service_path servicePath,r.id repoId,r.name repoName
    FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id
    WHERE (? IS NULL OR r.id=?) AND (? IS NULL OR s.service_path=?) AND (o.operation_name=? OR o.operation_path=? OR o.operation_path=?)
    ORDER BY r.name,s.service_path,o.operation_name,o.id`).all(repoId, repoId, start.servicePath, start.servicePath, requested, requested, requested.startsWith("/") ? requested : `/${requested}`);
  if (rows2.length === 0) return void 0;
  const repoCount = new Set(rows2.map((row) => String(row.repoName))).size;
  const serviceCount = new Set(rows2.map((row) => `${String(row.repoName)}:${String(row.servicePath)}`)).size;
  if (!repoId && repoCount > 1) return { diagnostics: [{ severity: "warning", code: "trace_start_ambiguous", message: "Operation trace start matched multiple repositories; add --repo to disambiguate", normalizedSelectorValue: requested, resolutionStage: "operation", resolutionStatus: "ambiguous_operation", candidates: rows2 }] };
  if (!start.servicePath && serviceCount > 1) return { diagnostics: [{ severity: "warning", code: "trace_start_ambiguous", message: "Operation trace start matched multiple services; add --service to disambiguate", normalizedSelectorValue: requested, resolutionStage: "operation", resolutionStatus: "ambiguous_operation", candidates: rows2 }] };
  if (rows2.length !== 1) return { diagnostics: [{ severity: "warning", code: "trace_start_ambiguous", message: "Operation trace start matched multiple indexed operations", normalizedSelectorValue: requested, resolutionStage: "operation", resolutionStatus: "ambiguous_operation", candidates: rows2 }] };
  const operationId = String(rows2[0]?.operationId);
  const impl = implementationScope(db, operationId);
  if (impl.edge?.status === "resolved" && impl.files.size > 0) return { files: impl.files, symbols: impl.symbolId ? /* @__PURE__ */ new Set([impl.symbolId]) : void 0, operationId, diagnostics: [] };
  if (impl.edge) return { operationId, diagnostics: [{ severity: "warning", code: impl.edge.status === "ambiguous" ? "trace_start_ambiguous" : "trace_start_implementation_unresolved", message: `Indexed operation matched but implementation edge is ${String(impl.edge.status ?? "unresolved")}`, resolutionStage: "implementation", resolutionStatus: impl.edge.status === "ambiguous" ? "ambiguous_implementation" : "rejected_implementation", implementationEdgeId: impl.edge.id, implementationStatus: impl.edge.status, candidates: parseEvidence(impl.edge.evidence_json).candidates }] };
  return { operationId, diagnostics: [{ severity: "warning", code: "trace_start_implementation_unresolved", message: "Indexed operation matched but no implementation candidate exists", resolutionStage: "implementation", resolutionStatus: "operation_without_implementation" }] };
}
function sourceFilesForStart(db, repoId, start) {
  const handler = start.handler;
  const operation = normalizeOperation(start.operation ?? start.operationPath);
  if (!handler && !operation) return void 0;
  const rows2 = db.prepare(
    `SELECT DISTINCT hc.source_file sourceFile,s.id symbolId
       FROM handler_classes hc LEFT JOIN handler_methods hm ON hm.handler_class_id=hc.id LEFT JOIN symbols s ON s.repo_id=hc.repo_id AND s.source_file=hc.source_file AND s.name=hm.method_name
       WHERE (? IS NULL OR hc.repo_id=?) AND (? IS NULL OR hc.class_name=? OR hm.method_name=?)
         AND (? IS NULL OR hm.decorator_value=? OR hm.method_name=?)
         AND (? IS NULL OR EXISTS (SELECT 1 FROM cds_services s JOIN cds_operations o ON o.service_id=s.id WHERE s.repo_id=hc.repo_id AND s.service_path=? AND (? IS NULL OR o.operation_path=? OR o.operation_name=? OR hm.decorator_value=? OR hm.method_name=?)))`
  ).all(
    repoId,
    repoId,
    handler,
    handler,
    handler,
    operation,
    operation,
    operation,
    start.servicePath,
    start.servicePath,
    operation,
    operation,
    operation,
    operation,
    operation
  );
  if (rows2.length > 0) return { files: new Set(rows2.map((row) => row.sourceFile).filter(Boolean)), symbols: new Set(rows2.map((row) => Number(row.symbolId)).filter(Boolean)) };
  if (start.servicePath && operation) {
    const implRows = db.prepare(`SELECT DISTINCT hc.source_file sourceFile,sym.id symbolId
      FROM cds_services s JOIN cds_operations o ON o.service_id=s.id
      JOIN graph_edges e ON e.edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND e.status='resolved' AND e.from_kind='operation' AND e.from_id=CAST(o.id AS TEXT)
      JOIN handler_methods hm ON hm.id=CAST(e.to_id AS INTEGER)
      JOIN handler_classes hc ON hc.id=hm.handler_class_id
      LEFT JOIN symbols sym ON sym.repo_id=hc.repo_id AND sym.source_file=hc.source_file AND sym.name=hm.method_name
      WHERE (? IS NULL OR s.repo_id=?) AND s.service_path=? AND (o.operation_path=? OR o.operation_name=?)`).all(repoId, repoId, start.servicePath, operation, operation);
    if (implRows.length > 0) return { files: new Set(implRows.map((row) => row.sourceFile).filter(Boolean)), symbols: new Set(implRows.map((row) => Number(row.symbolId)).filter(Boolean)) };
  }
  return void 0;
}
function startScope(db, start) {
  const repo = start.repo ? db.prepare(
    "SELECT id,name FROM repositories WHERE name=? OR package_name=?"
  ).get(start.repo, start.repo) : void 0;
  if (start.repo && !repo) return { repo, selectorMatched: false };
  const operationScope = operationStartScope(db, repo?.id, start);
  const terminalOperationScope = operationScope && !operationScope.files && (operationScope.diagnostics ?? []).some((d) => d.resolutionStage === "operation" || d.resolutionStage === "implementation");
  const sourceScope = operationScope?.files || terminalOperationScope ? operationScope : sourceFilesForStart(db, repo?.id, start);
  const sourceFiles = sourceScope?.files;
  const hasSelector = Boolean(
    start.handler ?? start.operation ?? start.operationPath ?? start.servicePath
  );
  if (start.servicePath && !start.operation && !start.operationPath && !start.handler)
    return { repo, selectorMatched: false };
  return {
    repo,
    sourceFiles,
    symbolIds: sourceScope?.symbols,
    selectorMatched: !terminalOperationScope && (!hasSelector || sourceFiles !== void 0),
    startOperationId: operationScope?.operationId,
    startDiagnostics: operationScope?.diagnostics
  };
}
function handlerFilesForOperation(db, operationId) {
  const op = db.prepare(
    `SELECT o.operation_name operationName,o.operation_path operationPath,s.repo_id repoId
    FROM cds_operations o JOIN cds_services s ON s.id=o.service_id WHERE o.id=?`
  ).get(operationId);
  if (!op) return /* @__PURE__ */ new Set();
  const operation = normalizeOperation(op.operationPath ?? op.operationName);
  const rows2 = db.prepare(
    `SELECT DISTINCT hc.source_file sourceFile,sym.id symbolId FROM handler_classes hc
    JOIN handler_methods hm ON hm.handler_class_id=hc.id
    LEFT JOIN symbols sym ON sym.repo_id=hc.repo_id AND sym.source_file=hc.source_file AND sym.name=hm.method_name
    WHERE hc.repo_id=? AND (hm.decorator_value=? OR hm.method_name=? OR hm.decorator_value=?)`
  ).all(op.repoId, operation, operation, op.operationName);
  return new Set(rows2.map((row) => row.sourceFile).filter(Boolean));
}
function implementationEdge(db, operationId) {
  return db.prepare("SELECT * FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND from_kind='operation' AND from_id=? ORDER BY CASE status WHEN 'resolved' THEN 0 WHEN 'ambiguous' THEN 1 ELSE 2 END,id LIMIT 1").get(operationId);
}
function handlerMethodNode(db, methodId) {
  const row = db.prepare(`SELECT hm.id methodId,hm.method_name methodName,hm.decorator_value decoratorValue,hm.source_line sourceLine,hc.class_name className,hc.source_file sourceFile,r.name repoName,r.id repoId FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id JOIN repositories r ON r.id=hc.repo_id WHERE hm.id=?`).get(methodId);
  if (!row) return void 0;
  return { id: `handler_method:${methodId}`, kind: "handler_method", label: `${String(row.repoName)}:${String(row.className)}.${String(row.methodName)}`, ...row };
}
function implementationScope(db, operationId) {
  const edge = implementationEdge(db, operationId);
  if (!edge || edge.status !== "resolved") return { files: /* @__PURE__ */ new Set(), edge };
  const row = db.prepare("SELECT hc.repo_id repoId,hc.source_file sourceFile,s.id symbolId FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id LEFT JOIN symbols s ON s.repo_id=hc.repo_id AND s.source_file=hc.source_file AND s.name=hm.method_name WHERE hm.id=?").get(edge.to_id);
  return { repoId: row?.repoId, files: new Set(row?.sourceFile ? [row.sourceFile] : []), symbolId: row?.symbolId, edge };
}
function contextImplementationMethodId(edge, callerRepoId, remoteEvidence = {}) {
  if (!edge || edge.status !== "ambiguous" || callerRepoId === void 0) return { evidence: { status: "not_applicable" } };
  const evidence = JSON.parse(String(edge.evidence_json || "{}"));
  const scores = (evidence.candidates ?? []).filter((item) => item.accepted).map((item) => {
    const reasons = [];
    let score = Number(item.score ?? 0);
    if (Number(item.handlerPackage?.id) === callerRepoId) {
      score += 10;
      reasons.push("handler_package_matches_caller_repository");
    }
    if (Number(item.applicationPackage?.id) === callerRepoId) {
      score += 10;
      reasons.push("registration_package_matches_caller_repository");
    }
    if (typeof remoteEvidence.effectiveServicePath === "string" || typeof remoteEvidence.effectiveDestination === "string" || typeof remoteEvidence.effectiveAlias === "string") {
      score += 1;
      reasons.push("remote_call_context_available");
    }
    return { methodId: item.methodId, score, reasons, handlerPackage: item.handlerPackage, applicationPackage: item.applicationPackage };
  }).sort((a, b) => b.score - a.score);
  if (scores.length === 0) return { evidence: { status: "not_applicable", candidateScores: [] } };
  const [first, second] = scores;
  if (first && first.methodId !== void 0 && first.score > 0 && (!second || first.score > second.score)) return { methodId: String(first.methodId), evidence: { status: "selected", selectedMethodId: first.methodId, candidateScores: scores } };
  return { evidence: { status: "tied", tieReason: scores.length > 1 ? "duplicate_helper_implementation_candidates" : "no_unique_materially_stronger_candidate", candidateScores: scores } };
}
function handlerScope(db, methodId) {
  const row = db.prepare("SELECT hc.repo_id repoId,hc.source_file sourceFile,s.id symbolId FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id LEFT JOIN symbols s ON s.repo_id=hc.repo_id AND s.source_file=hc.source_file AND s.name=hm.method_name WHERE hm.id=?").get(methodId);
  if (!row) return void 0;
  return { repoId: row.repoId, files: new Set(row.sourceFile ? [row.sourceFile] : []), symbolId: row.symbolId };
}
function includeCall(type, options) {
  if (!options.includeDb && type === "local_db_query") return false;
  if (!options.includeExternal && type === "external_http") return false;
  if (!options.includeAsync && type.startsWith("async_")) return false;
  return true;
}
function graphForCalls(db, callIds) {
  const map = /* @__PURE__ */ new Map();
  if (callIds.length === 0) return map;
  const rows2 = db.prepare(
    `SELECT * FROM graph_edges WHERE from_kind='call' AND from_id IN (${callIds.map(() => "?").join(",")}) ORDER BY id`
  ).all(...callIds.map((id) => String(id)));
  for (const row of rows2) {
    const id = Number(row.from_id);
    map.set(id, [...map.get(id) ?? [], row]);
  }
  return map;
}
function hasRuntimeVariable(value, vars) {
  return typeof value === "string" && extractPlaceholders(value).some((key) => Object.hasOwn(vars, key));
}
function isRemoteRuntimeCandidate(row, evidence, vars) {
  if (!vars || Object.keys(vars).length === 0) return false;
  if (!["dynamic", "ambiguous", "unresolved"].includes(String(row.status ?? ""))) return false;
  if (!["DYNAMIC_EDGE_CANDIDATE", "UNRESOLVED_EDGE", "REMOTE_CALL_RESOLVES_TO_OPERATION"].includes(row.edge_type)) return false;
  if (row.status === "resolved") return false;
  return ["servicePath", "operationPath", "serviceAliasExpr", "serviceAlias", "destination"].some((key) => hasRuntimeVariable(evidence[key], vars));
}
function evidenceWithRuntimeVariables(evidence, vars) {
  if (!vars || Object.keys(vars).length === 0) return evidence;
  const substitutions = {};
  for (const key of ["servicePath", "operationPath", "serviceAliasExpr", "serviceAlias", "destination"]) {
    const substitution = substituteVariables(typeof evidence[key] === "string" ? String(evidence[key]) : void 0, vars);
    if (substitution.placeholders.length > 0) substitutions[key] = substitution;
  }
  const next = { ...evidence, runtimeVariablesApplied: true, runtimeSubstitutions: substitutions };
  for (const [key, value] of Object.entries(substitutions)) {
    if (value.effective) next[key] = value.effective;
  }
  const missing = Object.values(substitutions).flatMap((value) => value.missing);
  if (missing.length > 0) next.missingRuntimeVariables = [...new Set(missing)];
  return next;
}
function symbolNode(db, symbolId) {
  const row = db.prepare(`SELECT s.id symbolId,s.name symbolName,s.qualified_name qualifiedName,s.source_file sourceFile,s.start_line startLine,s.end_line endLine,r.name repoName,r.id repoId FROM symbols s JOIN repositories r ON r.id=s.repo_id WHERE s.id=?`).get(symbolId);
  if (!row) return void 0;
  const fileName = String(row.sourceFile ?? "").split("/").at(-1) ?? String(row.sourceFile ?? "");
  return { id: `symbol:${symbolId}`, kind: "symbol", label: `${fileName}:${String(row.qualifiedName ?? row.symbolName)}`, ...row };
}
function operationNode(db, operationId) {
  const row = db.prepare(`SELECT o.id operationId,o.operation_name operationName,o.operation_type operationType,o.operation_path operationPath,o.source_file sourceFile,o.source_line sourceLine,s.id serviceId,s.service_name serviceName,s.qualified_name qualifiedName,s.service_path servicePath,r.id repoId,r.name repoName FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id WHERE o.id=?`).get(operationId);
  if (!row) return void 0;
  return { id: `operation:${operationId}`, kind: "operation", label: `${String(row.repoName)}:${String(row.servicePath)}${String(row.operationPath)}`, ...row };
}
function workspaceIdForCall(db, callId) {
  return db.prepare("SELECT r.workspace_id workspaceId FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id WHERE c.id=?").get(callId)?.workspaceId;
}
function runtimeResolution(db, row, evidence, vars) {
  if (!isRemoteRuntimeCandidate(row, evidence, vars))
    return { row, evidence, unresolvedReason: row.unresolved_reason };
  const nextEvidence = evidenceWithRuntimeVariables(evidence, vars);
  const servicePath = typeof nextEvidence.servicePath === "string" ? nextEvidence.servicePath : void 0;
  const operationPath = typeof nextEvidence.normalizedOperationPath === "string" ? nextEvidence.normalizedOperationPath : typeof nextEvidence.operationPath === "string" ? nextEvidence.operationPath : void 0;
  const alias = typeof nextEvidence.serviceAliasExpr === "string" ? nextEvidence.serviceAliasExpr : typeof nextEvidence.serviceAlias === "string" ? nextEvidence.serviceAlias : void 0;
  const destination = typeof nextEvidence.destination === "string" ? nextEvidence.destination : void 0;
  const resolution = resolveOperation(db, { servicePath, operationPath, alias, destination, hasExplicitOverride: true, isDynamic: true }, workspaceIdForCall(db, row.from_id));
  nextEvidence.runtimeResolutionStatus = resolution.status;
  nextEvidence.runtimeResolutionReasons = resolution.reasons;
  if (resolution.target) {
    nextEvidence.runtimeResolvedCandidate = resolution.target;
    return { row: { ...row, to_kind: "operation", to_id: String(resolution.target.operationId), unresolved_reason: void 0, confidence: Math.max(0, Math.min(1, resolution.target.score)) }, evidence: nextEvidence, target: resolution.target };
  }
  const unresolvedReason = resolution.status === "dynamic" ? `Dynamic target is missing runtime variables: ${resolution.reasons.join(", ")}` : resolution.status === "ambiguous" ? "Ambiguous runtime operation candidates" : "No runtime operation candidate matched substituted service and operation path";
  return { row, evidence: nextEvidence, unresolvedReason };
}
function parseEvidence(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function receiverFromEvidence(value) {
  const evidence = parseEvidence(value);
  return typeof evidence.receiver === "string" ? evidence.receiver : void 0;
}
function hasDynamicPlaceholder(value) {
  return extractPlaceholders(value).length > 0;
}
function enrichBinding(row) {
  const effectiveServicePath = row.servicePathExpr && !hasDynamicPlaceholder(row.servicePathExpr) ? row.servicePathExpr : !row.servicePathExpr ? row.requireServicePath : void 0;
  const effectiveDestination = row.destinationExpr && !hasDynamicPlaceholder(row.destinationExpr) ? row.destinationExpr : !row.destinationExpr ? row.requireDestination : void 0;
  return { ...row, effectiveServicePath, effectiveDestination };
}
function knownBindingsForCalls(db, calls) {
  const map = /* @__PURE__ */ new Map();
  for (const call of calls) {
    const receiver = receiverFromEvidence(call.evidence_json);
    const bindingId = Number(call.service_binding_id ?? 0);
    if (!receiver || !bindingId) continue;
    const row = db.prepare(`SELECT b.id,b.alias,b.alias_expr aliasExpr,b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,b.source_file sourceFile,b.source_line sourceLine,req.service_path requireServicePath,req.destination requireDestination
      FROM service_bindings b LEFT JOIN cds_requires req ON req.repo_id=b.repo_id AND req.alias=b.alias
      WHERE b.id=?`).get(bindingId);
    if (row) map.set(receiver, enrichBinding({ ...row, bindingId, source: "local_service_binding", calleeReceiver: receiver }));
  }
  return map;
}
function knownBindingsForScope(db, repoId, symbolIds, files) {
  const map = /* @__PURE__ */ new Map();
  if (repoId === void 0) return map;
  const rows2 = db.prepare(`SELECT b.id,b.variable_name variableName,b.alias,b.alias_expr aliasExpr,b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,b.source_file sourceFile,b.source_line sourceLine,req.service_path requireServicePath,req.destination requireDestination
    FROM service_bindings b LEFT JOIN cds_requires req ON req.repo_id=b.repo_id AND req.alias=b.alias
    WHERE b.repo_id=?`).all(repoId);
  for (const row of rows2) {
    if (!row.variableName) continue;
    if (files && !files.has(String(row.sourceFile))) continue;
    if (symbolIds && symbolIds.size > 0) {
      const owner = db.prepare("SELECT id FROM symbols WHERE id IN (" + [...symbolIds].map(() => "?").join(",") + ") AND source_file=? AND start_line<=? AND end_line>=? LIMIT 1").get(...symbolIds, row.sourceFile, row.sourceLine, row.sourceLine);
      if (!owner) continue;
    }
    map.set(row.variableName, enrichBinding({ ...row, bindingId: Number(row.id), source: "local_service_binding", calleeReceiver: row.variableName }));
  }
  return map;
}
function contextForSymbolCall(db, symbolCall, callerBindings) {
  const next = /* @__PURE__ */ new Map();
  if (callerBindings.size === 0) return next;
  const callEvidence2 = parseEvidence(symbolCall.evidence_json);
  const callee = db.prepare("SELECT evidence_json evidenceJson FROM symbols WHERE id=?").get(symbolCall.callee_symbol_id);
  const calleeEvidence = parseEvidence(callee?.evidenceJson);
  const params = Array.isArray(calleeEvidence.parameters) ? calleeEvidence.parameters.filter((item) => typeof item === "string") : [];
  const parameterBindings = Array.isArray(calleeEvidence.parameterBindings) ? calleeEvidence.parameterBindings.filter((item) => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
  const parameterPropertyAliases = Array.isArray(calleeEvidence.parameterPropertyAliases) ? calleeEvidence.parameterPropertyAliases.filter((item) => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
  const args = Array.isArray(callEvidence2.callArguments) ? callEvidence2.callArguments : [];
  args.forEach((arg, index) => {
    const paramBinding = parameterBindings.find((binding) => binding.index === index);
    const param = paramBinding?.kind === "identifier" && typeof paramBinding.name === "string" ? paramBinding.name : params[index];
    if (arg.kind === "identifier" && typeof arg.name === "string") {
      const binding = callerBindings.get(arg.name);
      if (binding && param) next.set(param, { ...binding, source: "local_symbol_argument", callerArgument: arg.name, calleeParameter: param, calleeReceiver: param });
    }
    if (arg.kind === "object_literal" && Array.isArray(arg.properties)) {
      for (const prop of arg.properties) {
        if (typeof prop.property !== "string" || typeof prop.argument !== "string") continue;
        const binding = callerBindings.get(prop.argument);
        if (!binding) continue;
        const destructured = paramBinding?.kind === "object_pattern" && Array.isArray(paramBinding.properties) ? paramBinding.properties.find((item) => item.property === prop.property && typeof item.local === "string") : void 0;
        if (destructured && typeof destructured.local === "string") next.set(destructured.local, { ...binding, source: "local_symbol_destructured_object_argument", callerProperty: prop.property, callerArgument: prop.argument, calleeParameter: String(index), calleeReceiver: destructured.local });
        else if (param) {
          next.set(`${param}.${prop.property}`, { ...binding, source: "local_symbol_object_argument", callerProperty: prop.property, callerArgument: prop.argument, calleeParameter: param, calleeReceiver: `${param}.${prop.property}` });
          for (const alias of parameterPropertyAliases) {
            if (alias.parameter === param && alias.property === prop.property && typeof alias.local === "string") next.set(alias.local, { ...binding, source: "local_symbol_object_parameter_destructure", callerProperty: prop.property, callerArgument: prop.argument, calleeParameter: param, calleeObjectProperty: `${param}.${prop.property}`, calleeReceiver: alias.local, calleeLocalDestructuredIdentifier: alias.local, parameterPropertyAliasKind: alias.kind, parameterPropertyAliasLine: alias.line });
          }
        }
      }
    }
  });
  return next;
}
function contextualRuntimeResolution(db, call, binding, workspaceId, persistedRows = []) {
  if (!binding || String(call.call_type) !== "remote_action" || call.operation_path_expr === void 0 || call.operation_path_expr === null) return {};
  const normalized = normalizeODataOperationInvocationPath(String(call.operation_path_expr));
  const op = normalized?.normalizedOperationPath ?? (String(call.operation_path_expr).startsWith("/") ? String(call.operation_path_expr) : `/${String(call.operation_path_expr)}`);
  const servicePath = binding.effectiveServicePath ?? binding.servicePathExpr ?? binding.requireServicePath;
  const destination = binding.effectiveDestination ?? binding.destinationExpr ?? binding.requireDestination;
  const resolution = resolveOperation(db, { servicePath, operationPath: op, alias: binding.aliasExpr ?? binding.alias, destination, hasExplicitOverride: true, isDynamic: false }, workspaceId);
  const evidence = { contextualServiceBindingAttempted: true, contextualBinding: { source: binding.source, callerArgument: binding.callerArgument, callerProperty: binding.callerProperty, calleeParameter: binding.calleeParameter, calleeReceiver: binding.calleeReceiver, bindingSourceFile: binding.sourceFile, bindingSourceLine: binding.sourceLine, alias: binding.alias, aliasExpr: binding.aliasExpr, requireServicePath: binding.requireServicePath, requireDestination: binding.requireDestination, effectiveServicePath: binding.effectiveServicePath, effectiveDestination: binding.effectiveDestination }, operationPath: op, rawOperationPath: normalized?.rawOperationPath, normalizedOperationPath: normalized?.wasInvocation ? normalized.normalizedOperationPath : void 0, invocationArgumentPlaceholderKeys: normalized?.invocationArgumentPlaceholderKeys.length ? normalized.invocationArgumentPlaceholderKeys : void 0, servicePath, serviceAlias: binding.alias, serviceAliasExpr: binding.aliasExpr, destination, requireServicePath: binding.requireServicePath, requireDestination: binding.requireDestination, effectiveServicePath: binding.effectiveServicePath, effectiveDestination: binding.effectiveDestination, contextualResolutionStatus: resolution.status, contextualCandidateCount: resolution.candidates.length, candidates: resolution.candidates, contextualResolutionReasons: resolution.reasons, resolutionReasons: resolution.reasons };
  if (!resolution.target) return { evidence, unresolvedReason: resolution.status === "ambiguous" ? "Ambiguous contextual operation candidates" : resolution.status === "dynamic" ? `Dynamic contextual target is missing runtime variables: ${resolution.reasons.join(", ")}` : "No contextual operation candidate matched" };
  const resolvedEvidence = { ...evidence, contextualServiceBindingSelected: true, targetRepo: resolution.target.repoName, targetServicePath: resolution.target.servicePath, targetOperationPath: resolution.target.operationPath, targetOperation: resolution.target.operationName };
  const persistedResolved = persistedRows.find((item) => item.status === "resolved");
  if (persistedResolved) return { row: void 0, evidence: { ...resolvedEvidence, contextualPreservedPersistedResolvedEdge: true }, unresolvedReason: void 0 };
  return { row: { id: -Number(call.id), edge_type: "REMOTE_CALL_RESOLVES_TO_OPERATION", from_id: String(call.id), to_kind: "operation", to_id: String(resolution.target.operationId), confidence: resolution.target.score, evidence_json: JSON.stringify(resolvedEvidence), status: "resolved" }, evidence: resolvedEvidence, unresolvedReason: void 0 };
}
function edgeTarget(row, evidence) {
  const runtimeCandidate = evidence.runtimeResolvedCandidate;
  if (runtimeCandidate?.servicePath && runtimeCandidate.operationPath)
    return `${runtimeCandidate.servicePath}${runtimeCandidate.operationPath}`;
  const targetServicePath = typeof evidence.targetServicePath === "string" ? evidence.targetServicePath : void 0;
  const targetOperationPath = typeof evidence.targetOperationPath === "string" ? evidence.targetOperationPath : void 0;
  if (targetServicePath && targetOperationPath) return `${targetServicePath}${targetOperationPath}`;
  const servicePath = typeof evidence.servicePath === "string" ? evidence.servicePath : void 0;
  const operationPath = typeof evidence.operationPath === "string" ? evidence.operationPath : void 0;
  const targetOperation = typeof evidence.targetOperation === "string" ? evidence.targetOperation : void 0;
  const targetRepo = typeof evidence.targetRepo === "string" ? evidence.targetRepo : "";
  if (row.edge_type === "HANDLER_RUNS_DB_QUERY") return `Entity: ${row.to_id || "unknown"}`;
  if (row.edge_type === "HANDLER_RUNS_REMOTE_QUERY") return typeof evidence.remoteQueryTarget === "string" ? evidence.remoteQueryTarget : `Remote query: ${row.to_id || "unknown"}`;
  if (row.edge_type === "HANDLER_CALLS_EXTERNAL_HTTP") {
    const target = evidence.externalTarget;
    return typeof target?.label === "string" ? target.label : `External endpoint: ${row.to_id || "unknown"}`;
  }
  return servicePath && operationPath ? `${servicePath}${operationPath}` : targetOperation ? `${targetRepo}:${targetOperation}` : row.to_id;
}
function trace(db, start, options) {
  const scope = startScope(db, start);
  const diagnostics = db.prepare(
    "SELECT severity,code,message,source_file sourceFile,source_line sourceLine FROM diagnostics WHERE (? IS NULL OR repo_id=?)"
  ).all(scope.repo?.id, scope.repo?.id);
  const stale = db.prepare("SELECT name,graph_stale_reason reason FROM repositories WHERE graph_stale_reason IS NOT NULL AND (? IS NULL OR id=?)").all(scope.repo?.id, scope.repo?.id);
  for (const row of stale)
    diagnostics.unshift({ severity: "warning", code: "graph_stale", message: `Graph is stale for ${row.name ?? "repository"}: ${row.reason ?? "facts_changed"}. Run service-flow link.` });
  for (const diagnostic of scope.startDiagnostics ?? []) diagnostics.unshift(diagnostic);
  if (!scope.selectorMatched && !scope.startDiagnostics?.length)
    diagnostics.unshift({
      severity: "warning",
      code: "trace_start_not_found",
      message: start.servicePath && !start.operation && !start.operationPath && !start.handler ? "Service-only trace requires --operation or --path and will not broaden to the whole workspace" : "No handler source matched the requested trace start selector"
    });
  const maxDepth = positiveDepth(options.depth);
  const edges = [];
  const nodes = /* @__PURE__ */ new Map();
  const seenEdges = /* @__PURE__ */ new Set();
  const queue = scope.selectorMatched ? [{ repoId: scope.repo?.id, files: scope.sourceFiles, symbolIds: scope.symbolIds, depth: 1, context: /* @__PURE__ */ new Map() }] : [];
  if (scope.startOperationId && scope.selectorMatched) {
    const op = operationNode(db, scope.startOperationId);
    const impl = implementationScope(db, scope.startOperationId);
    if (op) nodes.set(String(op.id), op);
    if (impl.edge && impl.edge.status === "resolved") {
      const implEvidence = { ...parseEvidence(impl.edge.evidence_json), startResolution: { strategy: "indexed_operation_graph", matchedOperationId: scope.startOperationId, implementationEdgeId: impl.edge.id, implementationStatus: impl.edge.status, selectedHandlerMethodId: impl.edge.status === "resolved" ? impl.edge.to_id : void 0 } };
      const handlerNode = impl.edge.status === "resolved" ? handlerMethodNode(db, impl.edge.to_id) : void 0;
      if (handlerNode) nodes.set(String(handlerNode.id), handlerNode);
      seenEdges.add(Number(impl.edge.id));
      edges.push({ step: 1, type: "operation_implemented_by_handler", from: op?.label ? String(op.label) : `operation:${scope.startOperationId}`, to: handlerNode?.label ? String(handlerNode.label) : `${impl.edge.to_kind}:${impl.edge.to_id}`, evidence: implEvidence, confidence: Number(impl.edge.confidence ?? 0), unresolvedReason: impl.edge.status === "resolved" ? void 0 : String(impl.edge.unresolved_reason ?? impl.edge.status) });
    }
  }
  const seenScopes = /* @__PURE__ */ new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > maxDepth) continue;
    const contextKey = [...(current.context ?? /* @__PURE__ */ new Map()).keys()].sort().join(",");
    const key = `${current.repoId ?? "*"}:${[...current.symbolIds ?? /* @__PURE__ */ new Set(["*"])].sort().join(",")}:${[...current.files ?? /* @__PURE__ */ new Set(["*"])].sort().join(",")}:${contextKey}`;
    if (seenScopes.has(key)) continue;
    seenScopes.add(key);
    const calls = db.prepare(
      `SELECT c.*,r.name repoName FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id WHERE (? IS NULL OR c.repo_id=?) ORDER BY c.source_file,c.source_line`
    ).all(current.repoId, current.repoId);
    const filtered = calls.filter(
      (c) => (!current.symbolIds || current.symbolIds.has(Number(c.source_symbol_id))) && (!current.files || current.files.has(String(c.source_file))) && includeCall(String(c.call_type), options)
    );
    const callerBindings = new Map([...current.context ?? /* @__PURE__ */ new Map(), ...knownBindingsForScope(db, current.repoId, current.symbolIds, current.files), ...knownBindingsForCalls(db, filtered)]);
    if (current.symbolIds && current.symbolIds.size > 0 && current.depth < maxDepth) {
      const symbolRows = db.prepare(`SELECT sc.*,s.repo_id calleeRepoId,s.source_file calleeFile FROM symbol_calls sc LEFT JOIN symbols s ON s.id=sc.callee_symbol_id WHERE sc.caller_symbol_id IN (${[...current.symbolIds].map(() => "?").join(",")}) ORDER BY sc.source_file,sc.source_line`).all(...current.symbolIds);
      for (const symbolCall of symbolRows) {
        if (!symbolCall.callee_symbol_id) continue;
        const nextSymbols = /* @__PURE__ */ new Set([Number(symbolCall.callee_symbol_id)]);
        const nextFiles = /* @__PURE__ */ new Set([String(symbolCall.calleeFile)]);
        const nextRepoId = Number(symbolCall.calleeRepoId);
        const nextKey = `${nextRepoId}:${[...nextSymbols].join(",")}:${[...nextFiles].join(",")}`;
        const calleeNode = symbolNode(db, Number(symbolCall.callee_symbol_id));
        if (calleeNode) nodes.set(String(calleeNode.id), calleeNode);
        const evidence = { ...JSON.parse(String(symbolCall.evidence_json || "{}")), sourceFile: symbolCall.source_file, sourceLine: symbolCall.source_line, calleeSymbolId: symbolCall.callee_symbol_id, calleeSymbolName: calleeNode?.symbolName, calleeSymbolFile: calleeNode?.sourceFile, resolutionStatus: symbolCall.status };
        edges.push({ step: current.depth, type: "local_symbol_call", from: String(symbolCall.callee_expression), to: calleeNode?.label ? String(calleeNode.label) : `symbol:${String(symbolCall.callee_symbol_id)}`, evidence, confidence: Number(symbolCall.confidence ?? 0.8), unresolvedReason: String(symbolCall.status) === "resolved" ? void 0 : symbolCall.unresolved_reason ? String(symbolCall.unresolved_reason) : void 0 });
        if (seenScopes.has(nextKey)) edges.push({ step: current.depth, type: "cycle", from: String(symbolCall.callee_expression), to: nextKey, evidence: { cycle: true, symbolCallId: symbolCall.id }, confidence: 1, unresolvedReason: "Cycle detected; downstream symbol already visited" });
        else queue.push({ repoId: nextRepoId, files: nextFiles, symbolIds: nextSymbols, depth: current.depth + 1, context: contextForSymbolCall(db, symbolCall, callerBindings) });
      }
    }
    const graph = graphForCalls(
      db,
      filtered.map((c) => Number(c.id))
    );
    for (const call of filtered) {
      const callNode = `call:${call.id}`;
      nodes.set(callNode, {
        id: callNode,
        kind: "outbound_call",
        repo: call.repoName,
        file: call.source_file,
        line: call.source_line,
        callType: call.call_type
      });
      const persistedRowsForCall = graph.get(Number(call.id)) ?? [];
      const contextual = contextualRuntimeResolution(db, call, callerBindings.get(receiverFromEvidence(call.evidence_json) ?? ""), workspaceIdForCall(db, String(call.id)), persistedRowsForCall);
      const graphRows = contextual.row ? [contextual.row] : persistedRowsForCall;
      for (const row of graphRows) {
        if (seenEdges.has(Number(row.id))) continue;
        seenEdges.add(Number(row.id));
        const persistedEvidence = JSON.parse(
          String(row.evidence_json || "{}")
        );
        const rawEvidence = { ...persistedEvidence, ...contextual.evidence ?? {}, graphEdgeId: row.id, persistedGraphEdgeId: row.id > 0 ? row.id : void 0, outboundCallId: call.id, callSite: { sourceFile: call.source_file, sourceLine: call.source_line }, sourceFile: call.source_file, sourceLine: call.source_line, file: call.source_file, line: call.source_line, linker: { status: row.status, confidence: row.confidence, reason: row.unresolved_reason, edgeType: row.edge_type }, persistedTarget: { kind: row.to_kind, id: row.to_id }, contextualResolutionParticipated: Boolean(contextual.evidence?.contextualServiceBindingAttempted) };
        const effective = runtimeResolution(db, row, rawEvidence, options.vars);
        const evidence = effective.evidence;
        const effectiveRow = effective.row;
        const targetNode = `${effectiveRow.to_kind}:${effectiveRow.to_id}`;
        const opNode = effectiveRow.to_kind === "operation" ? operationNode(db, effectiveRow.to_id) : void 0;
        nodes.set(targetNode, opNode ?? {
          id: targetNode,
          kind: effectiveRow.to_kind,
          label: effectiveRow.to_kind === "db_entity" ? `Entity: ${effectiveRow.to_id || "unknown"}` : effectiveRow.to_id
        });
        const to = edgeTarget(effectiveRow, evidence);
        edges.push({
          step: current.depth,
          type: String(call.call_type),
          from: `${call.repoName}:${call.source_file}:${call.source_line}`,
          to,
          evidence,
          confidence: Number(effectiveRow.confidence ?? call.confidence),
          unresolvedReason: effective.unresolvedReason
        });
        if (effectiveRow.to_kind === "operation") {
          const implementation = implementationScope(db, effectiveRow.to_id);
          const contextSelection = contextImplementationMethodId(implementation.edge, current.repoId, evidence);
          const contextMethodId = contextSelection.methodId;
          const contextNode = contextMethodId ? handlerMethodNode(db, contextMethodId) : void 0;
          if (implementation.edge) {
            const implEvidence = JSON.parse(String(implementation.edge.evidence_json || "{}"));
            const handlerNode = implementation.edge.status === "resolved" ? handlerMethodNode(db, implementation.edge.to_id) : contextNode;
            const implTo = handlerNode?.label ? String(handlerNode.label) : `${implementation.edge.to_kind}:${implementation.edge.to_id}`;
            if (handlerNode) nodes.set(String(handlerNode.id), handlerNode);
            edges.push({
              step: current.depth,
              type: "operation_implemented_by_handler",
              from: to,
              to: implTo,
              evidence: contextMethodId ? { ...implEvidence, contextualImplementationSelected: true, contextualImplementation: contextSelection.evidence } : { ...implEvidence, contextualImplementation: contextSelection.evidence },
              confidence: Number(implementation.edge.confidence ?? 0),
              unresolvedReason: implementation.edge.status === "resolved" || contextMethodId ? void 0 : String(implementation.edge.unresolved_reason ?? implementation.edge.status)
            });
          }
          if (current.depth >= maxDepth) continue;
          const contextScope = contextMethodId ? handlerScope(db, contextMethodId) : void 0;
          const files = contextScope?.files ?? (implementation.files.size > 0 ? implementation.files : handlerFilesForOperation(db, effectiveRow.to_id));
          const symbolIds = contextScope?.symbolId ? /* @__PURE__ */ new Set([contextScope.symbolId]) : implementation.symbolId ? /* @__PURE__ */ new Set([implementation.symbolId]) : void 0;
          if ((implementation.edge?.status === "resolved" || contextScope) && files.size > 0) {
            const targetRepoId = contextScope?.repoId ?? implementation.repoId ?? db.prepare(
              "SELECT s.repo_id repoId FROM cds_operations o JOIN cds_services s ON s.id=o.service_id WHERE o.id=?"
            ).get(effectiveRow.to_id)?.repoId;
            const nextKey = `${targetRepoId ?? "*"}:${[...symbolIds ?? /* @__PURE__ */ new Set(["*"])].sort().join(",")}:${[...files].sort().join(",")}`;
            if (seenScopes.has(nextKey))
              edges.push({
                step: current.depth,
                type: "cycle",
                from: to,
                to: nextKey,
                evidence: { ...evidence, cycle: true },
                confidence: 1,
                unresolvedReason: "Cycle detected; downstream scope already visited"
              });
            else
              queue.push({
                repoId: targetRepoId,
                files,
                symbolIds,
                depth: current.depth + 1
              });
          }
        }
      }
    }
  }
  return { start, nodes: [...nodes.values()], edges, diagnostics };
}

export {
  normalizePath,
  stripQuotes,
  discoverRepositories,
  parsePackageJson,
  parseCdsFile,
  parseDecorators,
  parseHandlerRegistrations,
  redactText,
  redactValue,
  normalizeODataOperationInvocationPath,
  containsSupportedOutboundCall,
  parseOutboundCalls,
  parseServiceBindings,
  applyVariables,
  extractPlaceholders,
  substituteVariables,
  linkWorkspace,
  trace
};
//# sourceMappingURL=chunk-5SR4SFSU.js.map