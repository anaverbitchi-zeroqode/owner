"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const PAGE_LIMIT = 100;

function getRequiredEnv(name, env = process.env) {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function buildApiUrl(baseUrl, relativePath) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath, normalizedBase);
}

function parseBasicAuth(headerValue) {
  if (!headerValue || !headerValue.startsWith("Basic ")) return null;
  const encoded = headerValue.slice("Basic ".length).trim();
  if (!encoded) return null;

  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) return null;

  return {
    login: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

function normalizeDelimiter(value) {
  if (typeof value !== "string") return ",";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "," || trimmed === " ") return ",";
  if (trimmed === "\\t" || trimmed.toLowerCase() === "tab") return "\t";
  return value;
}

function readProperty(node, key) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  if (key in node) return node[key];

  const normalizedKey = key.trim().toLowerCase();
  for (const existingKey of Object.keys(node)) {
    if (existingKey.trim().toLowerCase() === normalizedKey) {
      return node[existingKey];
    }
  }
  return undefined;
}

function formatUsPhone(value) {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length !== 10) return String(value);
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function formatValue(value, format, nullAs, timezone) {
  if (value === null || value === undefined || value === "") return nullAs;
  if (!format) return value;

  if (format === "us_phone") {
    return formatUsPhone(value);
  }
  if (format === "upper") {
    return String(value).toUpperCase();
  }
  if (format === "lower") {
    return String(value).toLowerCase();
  }
  if (format === "currency") {
    const numberValue = Number(value);
    if (Number.isNaN(numberValue)) return value;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(numberValue);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  if (format === "MMMM YYYY") {
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: timezone,
    }).format(date);
  }
  if (format === "MMMM D, YYYY") {
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: timezone,
    }).format(date);
  }
  return value;
}

function valueToCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function readByPath(record, pathValue) {
  const segments = String(pathValue || "")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return undefined;

  let current = record;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (Array.isArray(current)) {
      current = current[0];
    }

    // Option set / text fallback:
    // if user asks for ".Display" but value is already plain text,
    // return that text instead of blank.
    if (
      (typeof current === "string" || typeof current === "number" || typeof current === "boolean") &&
      segment.toLowerCase() === "display"
    ) {
      return current;
    }

    current = readProperty(current, segment);
    if (current === undefined || current === null) {
      return undefined;
    }
  }
  return current;
}

function setByPath(record, pathValue, value) {
  const segments = String(pathValue || "")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return;

  let current = record;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (Array.isArray(current)) {
      current = current[0];
      if (!current || typeof current !== "object") return;
    }

    let next = readProperty(current, segment);
    if (!next || typeof next !== "object") {
      next = {};
      current[segment] = next;
    }
    current = next;
  }

  const lastSegment = segments[segments.length - 1];
  if (!current || typeof current !== "object") return;
  current[lastSegment] = value;
}

function isLikelyBubbleThingId(value) {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (!candidate) return false;

  // Bubble thing ids are typically in the form:
  // 1753211664482x180022965038210600
  // We only treat such values as resolvable references.
  return /^\d{10,}x\d{10,}$/.test(candidate);
}

function extractThingId(value) {
  if (!value) return null;
  if (typeof value === "string") {
    return isLikelyBubbleThingId(value) ? value.trim() : null;
  }
  if (typeof value === "object") {
    if (typeof value._id === "string" && isLikelyBubbleThingId(value._id)) return value._id.trim();
    if (typeof value.id === "string" && isLikelyBubbleThingId(value.id)) return value.id.trim();
  }
  return null;
}

function mapRecordToCsvRow(record, columns, nullAs, timezone) {
  const row = {};
  for (const column of columns) {
    const rawValue = readByPath(record, column.path);
    row[column.header] = valueToCell(formatValue(rawValue, column.format, nullAs, timezone));
  }
  return row;
}

function isValidTimeZone(timezone) {
  if (typeof timezone !== "string" || !timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone.trim() }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function toCsv(rows, columns, delimiter, encloseInQuotes, includeHeader) {
  const escapeCell = (value) => {
    const stringValue = valueToCell(value);
    const escaped = stringValue.replace(/"/g, "\"\"");
    return encloseInQuotes ? `"${escaped}"` : escaped;
  };

  const csvLines = [];
  if (includeHeader) {
    csvLines.push(columns.map((column) => escapeCell(column)).join(delimiter));
  }

  for (const row of rows) {
    csvLines.push(columns.map((column) => escapeCell(row[column] || "")).join(delimiter));
  }

  return `${csvLines.join("\n")}\n`;
}

function parseExportRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object.");
  }

  const { source, resolve, columns, options } = body;

  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("source must be an object.");
  }
  if (typeof source.type !== "string" || !source.type.trim()) {
    throw new Error("source.type must be a non-empty string.");
  }
  if (source.filter !== undefined && (typeof source.filter !== "object" || Array.isArray(source.filter))) {
    throw new Error("source.filter must be an object when provided.");
  }

  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error("columns must be a non-empty array.");
  }
  if (resolve !== undefined && !Array.isArray(resolve)) {
    throw new Error("resolve must be an array when provided.");
  }
  const normalizedRootResolve = (resolve || []).map((rule, ruleIndex) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`resolve[${ruleIndex}] must be an object.`);
    }
    if (typeof rule.path !== "string" || !rule.path.trim()) {
      throw new Error(`resolve[${ruleIndex}].path must be a non-empty string.`);
    }
    if (typeof rule.type !== "string" || !rule.type.trim()) {
      throw new Error(`resolve[${ruleIndex}].type must be a non-empty string.`);
    }
    if (rule.api_type !== undefined && (typeof rule.api_type !== "string" || !rule.api_type.trim())) {
      throw new Error(`resolve[${ruleIndex}].api_type must be a non-empty string when provided.`);
    }
    return {
      path: rule.path.trim(),
      type: rule.type.trim(),
      apiType: (rule.api_type || rule.type).trim(),
    };
  });

  const normalizedColumns = columns.map((column, index) => {
    if (!column || typeof column !== "object" || Array.isArray(column)) {
      throw new Error(`columns[${index}] must be an object.`);
    }
    if (typeof column.header !== "string" || !column.header.trim()) {
      throw new Error(`columns[${index}].header must be a non-empty string.`);
    }
    if (typeof column.path !== "string" || !column.path.trim()) {
      throw new Error(`columns[${index}].path must be a non-empty string.`);
    }
    if (column.format !== undefined && typeof column.format !== "string") {
      throw new Error(`columns[${index}].format must be a string when provided.`);
    }
    if (column.resolve !== undefined && !Array.isArray(column.resolve)) {
      throw new Error(`columns[${index}].resolve must be an array when provided.`);
    }

    const normalizedResolve = (column.resolve || []).map((rule, ruleIndex) => {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
        throw new Error(`columns[${index}].resolve[${ruleIndex}] must be an object.`);
      }
      if (typeof rule.path !== "string" || !rule.path.trim()) {
        throw new Error(`columns[${index}].resolve[${ruleIndex}].path must be a non-empty string.`);
      }
      if (typeof rule.type !== "string" || !rule.type.trim()) {
        throw new Error(`columns[${index}].resolve[${ruleIndex}].type must be a non-empty string.`);
      }
      if (rule.api_type !== undefined && (typeof rule.api_type !== "string" || !rule.api_type.trim())) {
        throw new Error(`columns[${index}].resolve[${ruleIndex}].api_type must be a non-empty string when provided.`);
      }
      return {
        path: rule.path.trim(),
        type: rule.type.trim(),
        apiType: (rule.api_type || rule.type).trim(),
      };
    });

    return {
      header: column.header.trim(),
      path: column.path.trim(),
      format: column.format ? column.format.trim() : null,
      resolve: normalizedResolve,
    };
  });

  if (options !== undefined && (typeof options !== "object" || Array.isArray(options))) {
    throw new Error("options must be an object when provided.");
  }

  const includeHeader = options?.include_header ?? true;
  const nullAs = options?.null_as ?? "";
  const fileName = options?.file_name ?? "filename";
  const encloseInQuotes = options?.enclose_in_quotes ?? false;
  const delimiter = normalizeDelimiter(options?.delimiter ?? ",");
  const limit = options?.limit;
  const timezone = options?.timezone ?? "UTC";

  if (typeof includeHeader !== "boolean") {
    throw new Error("options.include_header must be a boolean when provided.");
  }
  if (typeof nullAs !== "string") {
    throw new Error("options.null_as must be a string when provided.");
  }
  if (typeof fileName !== "string" || !fileName.trim()) {
    throw new Error("options.file_name must be a non-empty string when provided.");
  }
  if (typeof encloseInQuotes !== "boolean") {
    throw new Error("options.enclose_in_quotes must be a boolean when provided.");
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("options.limit must be a positive integer when provided.");
  }
  if (typeof timezone !== "string" || !timezone.trim()) {
    throw new Error("options.timezone must be a non-empty string when provided.");
  }
  if (!isValidTimeZone(timezone)) {
    throw new Error("options.timezone must be a valid IANA timezone (example: America/Toronto).");
  }

  return {
    dataType: source.type.trim(),
    filter: source.filter || {},
    resolve: normalizedRootResolve,
    columns: normalizedColumns,
    includeHeader,
    nullAs,
    fileName: fileName.trim(),
    encloseInQuotes,
    delimiter,
    limit,
    timezone: timezone.trim(),
  };
}

function parseFilterValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return value;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;

  const date = new Date(trimmed);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return value;
}

function buildConstraintsFromFilter(filter) {
  const constraints = [];
  for (const [rawKey, rawValue] of Object.entries(filter || {})) {
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;

    let key = rawKey;
    let constraintType = "equals";
    if (rawKey.endsWith("_gte")) {
      key = rawKey.slice(0, -4);
      constraintType = "greater than or equal";
    } else if (rawKey.endsWith("_lte")) {
      key = rawKey.slice(0, -4);
      constraintType = "less than or equal";
    } else if (rawKey.endsWith("_gt")) {
      key = rawKey.slice(0, -3);
      constraintType = "greater than";
    } else if (rawKey.endsWith("_lt")) {
      key = rawKey.slice(0, -3);
      constraintType = "less than";
    } else if (rawKey.endsWith("_contains")) {
      key = rawKey.slice(0, -9);
      constraintType = "contains";
    }

    constraints.push({
      key,
      constraint_type: constraintType,
      value: parseFilterValue(rawValue),
    });
  }
  return constraints;
}

async function fetchPage({
  baseUrl,
  token,
  dataType,
  constraints,
  cursor,
  limit,
  subrequestHistory,
  historyContext,
}) {
  const endpoint = buildApiUrl(baseUrl, `api/1.1/obj/${dataType}`);
  endpoint.searchParams.set("constraints", JSON.stringify(constraints));
  if (typeof limit === "number") {
    endpoint.searchParams.set("limit", String(limit));
  }
  if (typeof cursor === "number") {
    endpoint.searchParams.set("cursor", String(cursor));
  }

  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const body = await response.text();
  if (Array.isArray(subrequestHistory)) {
    subrequestHistory.push({
      step: historyContext?.step || "list",
      type: dataType,
      path: historyContext?.path || "/obj",
      cursor: cursor ?? null,
      limit: limit ?? null,
      status: response.status,
      durationMs: Date.now() - startedAt,
      resultCount: null,
      cache: historyContext?.cache || "-",
    });
  }
  if (!response.ok) {
    throw new Error(`Bubble API returned ${response.status}: ${body.slice(0, 500)}`);
  }

  const parsed = JSON.parse(body);
  if (!parsed.response || !Array.isArray(parsed.response.results)) {
    throw new Error("Unexpected Bubble response shape: missing response.results");
  }

  if (Array.isArray(subrequestHistory) && subrequestHistory.length > 0) {
    subrequestHistory[subrequestHistory.length - 1].resultCount = parsed.response.results.length;
  }
  return parsed.response;
}

function getResolvePlan(columns, rootResolveRules = []) {
  const planMap = new Map();
  for (const rule of rootResolveRules) {
    const key = `${rule.path}|||${rule.type}|||${rule.apiType || rule.type}`;
    if (!planMap.has(key)) {
      planMap.set(key, { path: rule.path, type: rule.type, apiType: rule.apiType || rule.type });
    }
  }
  for (const column of columns) {
    for (const rule of column.resolve || []) {
      const key = `${rule.path}|||${rule.type}|||${rule.apiType || rule.type}`;
      if (!planMap.has(key)) {
        planMap.set(key, { path: rule.path, type: rule.type, apiType: rule.apiType || rule.type });
      }
    }
  }
  return Array.from(planMap.values()).sort((a, b) => a.path.split(".").length - b.path.split(".").length);
}

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function batchFetchByIds({ baseUrl, token, dataType, ids, subrequestHistory, rulePath }) {
  const chunks = chunkArray(ids, 100);
  const fetched = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const idChunk = chunks[i];
    const constraints = [{ key: "_id", constraint_type: "in", value: idChunk }];
    const results = await fetchAllRecords({
      baseUrl,
      token,
      dataType,
      constraints,
      maxRecords: undefined,
      subrequestHistory,
      historyContext: {
        step: "resolve-batch",
        path: `${rulePath} [chunk ${i + 1}/${chunks.length}]`,
      },
    });
    fetched.push(...results);
  }
  return fetched;
}

async function applyResolvePlan(records, resolvePlan, context) {
  for (const rule of resolvePlan) {
    const missingIds = new Set();

    for (const record of records) {
      const currentValue = readByPath(record, rule.path);
      if (currentValue === undefined || currentValue === null) continue;
      const valueList = Array.isArray(currentValue) ? currentValue : [currentValue];
      for (const item of valueList) {
        const refId = extractThingId(item);
        if (!refId) continue;
        const cacheKey = `${rule.type}::${refId}`;
        if (!context.resolveCache.has(cacheKey)) {
          missingIds.add(refId);
        } else if (Array.isArray(context.subrequestHistory)) {
          context.subrequestHistory.push({
            step: "resolve-batch",
            type: rule.apiType,
            path: `${rule.path} [cache]`,
            cursor: null,
            limit: null,
            status: "CACHE",
            durationMs: 0,
            resultCount: 1,
            cache: "hit",
          });
        }
      }
    }

    if (missingIds.size > 0) {
      console.log(`${context.logPrefix} Resolving references in batch`, {
        path: rule.path,
        type: rule.type,
        apiType: rule.apiType,
        ids: missingIds.size,
      });

      let fetchedThings;
      try {
        fetchedThings = await batchFetchByIds({
          baseUrl: context.baseUrl,
          token: context.token,
          dataType: rule.apiType,
          ids: Array.from(missingIds),
          subrequestHistory: context.subrequestHistory,
          rulePath: rule.path,
        });
      } catch (error) {
        if (String(error.message).includes("Type not found")) {
          throw new Error(
            `${error.message}. For display names use resolve.api_type with real Data API type slug (rule path "${rule.path}").`
          );
        }
        throw error;
      }

      for (const thing of fetchedThings) {
        const thingId = extractThingId(thing);
        if (!thingId) continue;
        const cacheKey = `${rule.type}::${thingId}`;
        context.resolveCache.set(cacheKey, thing);
      }
    }

    for (const record of records) {
      const currentValue = readByPath(record, rule.path);
      if (currentValue === undefined || currentValue === null) continue;
      const valueList = Array.isArray(currentValue) ? currentValue : [currentValue];
      const resolvedList = valueList.map((item) => {
        const refId = extractThingId(item);
        if (!refId) return item;
        const cacheKey = `${rule.type}::${refId}`;
        return context.resolveCache.get(cacheKey) || item;
      });
      setByPath(record, rule.path, Array.isArray(currentValue) ? resolvedList : resolvedList[0] ?? null);
    }
  }
}

async function fetchAllRecords({
  baseUrl,
  token,
  dataType,
  constraints,
  maxRecords,
  subrequestHistory,
  historyContext,
}) {
  const allResults = [];
  let cursor = undefined;
  let remaining = 0;

  do {
    const limitLeft =
      typeof maxRecords === "number" ? Math.max(0, maxRecords - allResults.length) : PAGE_LIMIT;
    const requestLimit = Math.min(PAGE_LIMIT, limitLeft);
    if (requestLimit <= 0) break;

    const response = await fetchPage({
      baseUrl,
      token,
      dataType,
      constraints,
      cursor,
      limit: requestLimit,
      subrequestHistory,
      historyContext,
    });

    const results = response.results || [];
    const acceptedResults =
      typeof maxRecords === "number"
        ? results.slice(0, Math.max(0, maxRecords - allResults.length))
        : results;
    remaining = Number(response.remaining || 0);
    cursor =
      typeof response.cursor === "number" ? response.cursor + results.length : undefined;

    allResults.push(...acceptedResults);
  } while (remaining > 0 && (typeof maxRecords !== "number" || allResults.length < maxRecords));

  return allResults;
}

function printSubrequestHistory(logPrefix, subrequestHistory) {
  if (!Array.isArray(subrequestHistory) || subrequestHistory.length === 0) return;
  console.log(`${logPrefix} Subrequest history table`);
  console.table(subrequestHistory);
}

app.get("/v1/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

async function handleExport(req, res) {
  const startedAt = Date.now();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logPrefix = `[csv-export][${requestId}]`;
  const subrequestHistory = [];

  try {
    console.log(`${logPrefix} Request started`, {
      method: req.method,
      path: req.path,
      ip: req.ip,
    });

    const expectedLogin = getRequiredEnv("EXPORT_LOGIN", process.env);
    const expectedPassword = getRequiredEnv("EXPORT_PASSWORD", process.env);

    const parsedAuth = parseBasicAuth(req.get("authorization"));
    if (
      !parsedAuth ||
      parsedAuth.login !== expectedLogin ||
      parsedAuth.password !== expectedPassword
    ) {
      console.warn(`${logPrefix} Unauthorized request`);
      res.set("WWW-Authenticate", 'Basic realm="csv-export"');
      return res.status(401).json({ error: "Unauthorized" });
    }
    console.log(`${logPrefix} Auth successful`);

    let exportRequest;
    try {
      exportRequest = parseExportRequest(req.body);
    } catch (validationError) {
      console.warn(`${logPrefix} Validation failed`, { error: validationError.message });
      return res.status(400).json({ error: validationError.message });
    }
    console.log(`${logPrefix} Request parsed`, {
      dataType: exportRequest.dataType,
      columns: exportRequest.columns.length,
      hasFilter: Object.keys(exportRequest.filter || {}).length > 0,
      includeHeader: exportRequest.includeHeader,
      limit: exportRequest.limit ?? null,
    });

    const baseUrl = getRequiredEnv("BUBBLE_BASE_URL", process.env);
    const token = getRequiredEnv("BUBBLE_API_TOKEN", process.env);

    const constraints = buildConstraintsFromFilter(exportRequest.filter);
    const resolvePlan = getResolvePlan(exportRequest.columns, exportRequest.resolve);
    console.log(`${logPrefix} Fetching Bubble records`, {
      dataType: exportRequest.dataType,
      constraints: constraints.length,
      resolveRules: resolvePlan.length,
      maxRecords: exportRequest.limit ?? null,
    });

    const records = await fetchAllRecords({
      baseUrl,
      token,
      dataType: exportRequest.dataType,
      constraints,
      maxRecords: exportRequest.limit,
      subrequestHistory,
    });
    console.log(`${logPrefix} Bubble fetch complete`, { records: records.length });

    const resolveContext = {
      baseUrl,
      token,
      logPrefix,
      resolveCache: new Map(),
      subrequestHistory,
    };
    await applyResolvePlan(records, resolvePlan, resolveContext);
    if (resolvePlan.length > 0) {
      console.log(`${logPrefix} Reference resolving complete`, {
        resolvedUniqueRefs: resolveContext.resolveCache.size,
      });
    }

    const normalizedRows = records.map((record) =>
      mapRecordToCsvRow(record, exportRequest.columns, exportRequest.nullAs, exportRequest.timezone)
    );
    const columns = exportRequest.columns.map((column) => column.header);
    const csv = toCsv(
      normalizedRows,
      columns,
      exportRequest.delimiter,
      exportRequest.encloseInQuotes,
      exportRequest.includeHeader
    );
    console.log(`${logPrefix} CSV generated`, {
      rows: normalizedRows.length,
      columns: columns.length,
      bytes: Buffer.byteLength(csv, "utf8"),
    });
    const safeFileName = exportRequest.fileName.replace(/[^\w.-]+/g, "_");
    const filename = safeFileName.endsWith(".csv") ? safeFileName : `${safeFileName}.csv`;

    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    });
    console.log(`${logPrefix} Response sent`, {
      status: 200,
      durationMs: Date.now() - startedAt,
      filename,
    });
    printSubrequestHistory(logPrefix, subrequestHistory);
    return res.status(200).send(csv);
  } catch (error) {
    console.error(`${logPrefix} Export failed`, {
      durationMs: Date.now() - startedAt,
      error: error.message,
    });
    printSubrequestHistory(logPrefix, subrequestHistory);
    return res.status(500).json({ error: `Export failed: ${error.message}` });
  }
}

app.post("/api/v1/csv-export", handleExport);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
