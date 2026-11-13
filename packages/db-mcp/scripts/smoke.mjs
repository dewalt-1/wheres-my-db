#!/usr/bin/env node
// Live smoke check: calls every tool once against the real services.
// Unit tests mock HTTP, so this is the only thing that notices when an
// upstream API changes or disappears. Run with: npm run smoke -w db-mcp
// Exits 1 if any required check fails.

import { createServer } from "../dist/server.js";

const { callTool } = createServer();
let failed = 0;

async function check(label, tool, args, summarise) {
  const started = Date.now();
  const res = await callTool(tool, args);
  const ms = Date.now() - started;
  const text = res.content[0].text;
  if (res.isError) {
    failed++;
    console.log(`FAIL  ${label} (${ms}ms): ${text.slice(0, 200)}`);
    return undefined;
  }
  const data = JSON.parse(text).data;
  try {
    console.log(`ok    ${label} (${ms}ms): ${summarise(data)}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${label} (${ms}ms): ${err.message}`);
  }
  return data;
}

const stations = await check("resolve_station", "resolve_station", { query: "Köln Hbf" }, (d) => `${d.length} matches, first: ${d[0]?.name}`);
const koeln = stations?.[0];
const frankfurt = (await check("resolve_station (2)", "resolve_station", { query: "Frankfurt (Main) Hbf" }, (d) => `first: ${d[0]?.name}`))?.[0];

if (koeln) {
  const board = await check("get_departures", "get_departures", { stationId: koeln.id, limit: 20 }, (d) => `${d.length} departures, ${d.filter((x) => x.realTime).length} with live data, worst delay ${Math.max(0, ...d.map((x) => x.delayMinutes))} min`);
  const first = board?.[0];
  if (first) {
    await check("find_train", "find_train", { name: first.trainName, stationId: koeln.id }, (d) => `${d.length} run(s) of ${first.trainName}`);
    await check("get_train_status", "get_train_status", { tripId: first.tripId }, (d) => `${d.name}: ${d.stopovers.length} stops, live=${d.realTime}`);
  }
  if (frankfurt) {
    await check("plan_journey", "plan_journey", { fromStationId: koeln.id, toStationId: frankfurt.id }, (d) => `${d.length} options, ${d.reduce((n, o) => n + o.riskyTransfers.length, 0)} risky transfer(s)`);
  }
  await check("get_late_trains", "get_late_trains", { lat: koeln.lat, lon: koeln.lon }, (d) => `${d.trainsChecked} trains checked, ${d.lateTrains.length} late, ${d.lateTrains.filter((t) => t.likelyStuck).length} likely stuck`);
  await check("get_weather_risk", "get_weather_risk", { lat: koeln.lat, lon: koeln.lon }, (d) => {
    if (d.warningsUnavailable) throw new Error("weather service unreachable");
    return `${d.warnings.length} warning(s) for Köln`;
  });
  // Munich sits in a merged city+district warning region, a case the old client missed.
  await check("get_weather_risk (Munich)", "get_weather_risk", { lat: 48.137, lon: 11.575 }, (d) => {
    if (d.warningsUnavailable) throw new Error("weather service unreachable");
    return `${d.warnings.length} warning(s): ${d.warnings.map((w) => `${w.type} L${w.level}`).join(", ") || "none"}`;
  });
}

if (failed > 0) {
  console.log(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll live checks passed.");
