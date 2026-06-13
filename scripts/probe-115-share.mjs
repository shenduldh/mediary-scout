#!/usr/bin/env node
// Probe: call 115 share/receive on a set of share links and print the RAW
// response, to learn exactly what 115 returns for expired / cancelled /
// wrong-password / healthy shares. Receives into the 115 TEST ROOT only.
//
//   node scripts/probe-115-share.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadDotEnv(envPath) {
  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv(path.join(repoRoot, ".env"));

const cookie = process.env.PAN115_COOKIE;
const testRoot = process.env.MEDIA_TRACK_115_TEST_ROOT_CID;
if (!cookie || !testRoot) {
  console.error("PAN115_COOKIE and MEDIA_TRACK_115_TEST_ROOT_CID required");
  process.exit(1);
}

// [label, shareCode, receiveCode]
const shares = [
  ["#1 expired", "sww96353nl6", "g876"],
  ["#2 cancelled", "swwax3x3wlk", "t868"],
  ["#3 cancelled", "swwmu0w3wlk", "x640"],
  ["#4 wrong password", "swz6url3wrb", "r8b8"],
  ["#5 healthy (85G)", "swz6url3wrb", "6969"],
];

for (const [label, shareCode, receiveCode] of shares) {
  const body = new URLSearchParams([
    ["share_code", shareCode],
    ["receive_code", receiveCode],
    ["cid", testRoot],
  ]).toString();
  try {
    const res = await fetch("https://115cdn.com/webapi/share/receive", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Referer: `https://115cdn.com/s/${shareCode}?password=${receiveCode}`,
        Origin: "https://115.com",
      },
      body,
    });
    const json = await res.json().catch(() => ({ parseError: true }));
    console.log(`${label} [${shareCode}/${receiveCode}] →`, JSON.stringify(json));
  } catch (error) {
    console.log(`${label} [${shareCode}/${receiveCode}] → ERROR`, error?.message ?? String(error));
  }
  await new Promise((r) => setTimeout(r, 1500));
}
