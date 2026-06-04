#!/usr/bin/env node
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

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

function waitForServerReady(child, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Server startup timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onData = (chunk) => {
      const text = String(chunk);
      if (!settled && pattern.test(text)) {
        settled = true;
        clearTimeout(timeout);
        resolve();
      }
    };

    const onExit = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Server exited before ready. exit_code=${code}`));
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

async function main() {
  loadDotEnv();

  const port = Number.parseInt(process.env.PORT || "3000", 10);
  const endpoint = `http://127.0.0.1:${port}/api/v1/csv-export`;
  const exportLogin = process.env.EXPORT_LOGIN;
  const exportPassword = process.env.EXPORT_PASSWORD;
  const dataType = process.env.EXPORT_DATA_TYPE || "TEST";

  if (!exportLogin || !exportPassword) {
    throw new Error("EXPORT_LOGIN and EXPORT_PASSWORD are required in .env for export test.");
  }

  const payload = {
    source: {
      type: dataType,
      filter: {},
    },
    columns: [
      { header: "id", path: "_id" },
      { header: "created", path: "Created Date", format: "MMMM D, YYYY" },
    ],
    options: {
      file_name: `bubble-export-endpoint-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      enclose_in_quotes: true,
      delimiter: ",",
      include_header: true,
      null_as: "",
    },
  };
  const outputDir = path.resolve(process.cwd(), "data");
  const outputPath = path.resolve(
    outputDir,
    `bubble-export-endpoint-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`
  );

  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    console.log(`[export-test] Starting local server on port ${port}...`);
    await waitForServerReady(child, /Server running on/, 15000);
    console.log("[export-test] Server is ready.");
    console.log(`[export-test] Requesting CSV from ${endpoint} ...`);

    const auth = Buffer.from(`${exportLogin}:${exportPassword}`, "utf8").toString("base64");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    console.log(`[export-test] Endpoint responded with status ${response.status}.`);
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Endpoint returned ${response.status}: ${body.slice(0, 500)}`);
    }

    await fsp.mkdir(outputDir, { recursive: true });
    console.log(`[export-test] Writing CSV to ${outputPath} ...`);
    await fsp.writeFile(outputPath, body, "utf8");
    console.log(`[export-test] Export endpoint test complete. File: ${outputPath}`);
  } finally {
    console.log("[export-test] Stopping local server...");
    child.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(`Export endpoint test failed: ${error.message}`);
  process.exitCode = 1;
});
