#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

// Set your Bubble data type here.
const DATA_TYPE = "TEST";

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

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function buildApiUrl(baseUrl, relativePath) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath, normalizedBase).toString();
}

function asInt(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRecord(index, runId) {
  return {
    text1: `text1_${runId}_${index}`,
    text2: `text2_${runId}_${index}`,
    text3: `text3_${runId}_${index}`,
  };
}

function splitIntoBatches(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function parseBulkResponse(raw) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { status: "error", message: `Unparseable response line: ${line}` };
      }
    });
}

async function postBulkWithRetry({
  endpoint,
  token,
  body,
  maxRetries,
  retryDelayMs,
  batchIndex,
}) {
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "text/plain",
          Accept: "text/plain, application/json",
        },
        body,
      });

      const text = await response.text();
      if (response.ok) {
        return text;
      }

      const retriable = response.status >= 500 || response.status === 429;
      if (!retriable || attempt > maxRetries) {
        throw new Error(
          `Batch ${batchIndex} failed with status ${response.status}: ${text.slice(
            0,
            500
          )}`
        );
      }

      console.warn(
        `Batch ${batchIndex} attempt ${attempt} got ${response.status}. Retrying in ${retryDelayMs}ms...`
      );
      await sleep(retryDelayMs);
    } catch (error) {
      if (attempt > maxRetries) {
        throw new Error(
          `Batch ${batchIndex} failed after ${attempt} attempts: ${error.message}`
        );
      }
      console.warn(
        `Batch ${batchIndex} attempt ${attempt} network error: ${error.message}. Retrying in ${retryDelayMs}ms...`
      );
      await sleep(retryDelayMs);
    }
  }
}

async function main() {
  loadDotEnv();

  const baseUrl = getRequiredEnv("BUBBLE_BASE_URL");
  const token = getRequiredEnv("BUBBLE_API_TOKEN");
  const dataType = DATA_TYPE;

  const totalRecords = asInt(process.env.TOTAL_RECORDS, 6000);
  const batchSize = Math.min(asInt(process.env.BATCH_SIZE, 1000), 1000);
  const throttleMs = asInt(process.env.THROTTLE_MS, 400);
  const retryDelayMs = asInt(process.env.RETRY_DELAY_MS, 1500);
  const maxRetries = asInt(process.env.MAX_RETRIES, 3);

  if (totalRecords <= 0) {
    throw new Error("TOTAL_RECORDS must be greater than 0.");
  }
  if (batchSize <= 0) {
    throw new Error("BATCH_SIZE must be greater than 0.");
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const allRecords = Array.from({ length: totalRecords }, (_, i) =>
    createRecord(i + 1, runId)
  );
  const batches = splitIntoBatches(allRecords, batchSize);
  const endpoint = buildApiUrl(baseUrl, `api/1.1/obj/${dataType}/bulk`);

  let successCount = 0;
  let errorCount = 0;

  console.log(
    `Starting bulk insert to ${dataType}. records=${totalRecords}, batches=${batches.length}, batchSize=${batchSize}`
  );

  for (let i = 0; i < batches.length; i += 1) {
    const batchIndex = i + 1;
    const batch = batches[i];
    const body = batch.map((record) => JSON.stringify(record)).join("\n");

    const rawResponse = await postBulkWithRetry({
      endpoint,
      token,
      body,
      maxRetries,
      retryDelayMs,
      batchIndex,
    });

    const lines = parseBulkResponse(rawResponse);
    let batchSuccess = 0;
    let batchErrors = 0;

    for (const line of lines) {
      if (line.status === "success") {
        batchSuccess += 1;
      } else {
        batchErrors += 1;
      }
    }

    successCount += batchSuccess;
    errorCount += batchErrors;

    console.log(
      `[batch ${batchIndex}/${batches.length}] sent=${batch.length} success=${batchSuccess} errors=${batchErrors}`
    );

    if (batchErrors > 0) {
      const sampleError = lines.find((line) => line.status !== "success");
      console.warn(
        `[batch ${batchIndex}] sample error: ${
          sampleError ? JSON.stringify(sampleError) : "unknown error"
        }`
      );
    }

    if (batchIndex < batches.length && throttleMs > 0) {
      await sleep(throttleMs);
    }
  }

  console.log(
    `Bulk insert complete. total=${totalRecords}, success=${successCount}, errors=${errorCount}`
  );
}

main().catch((error) => {
  console.error(`Bulk insert failed: ${error.message}`);
  process.exitCode = 1;
});
