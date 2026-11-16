#!/usr/bin/env node
// Live check of the line-ahead estimate. Finds trains that are held or very
// late right now, then runs the check for trains following them through the
// same stretch, and prints what it concludes. Uses Transitous only (no DB
// key). Run: npm run sweep -w db-mcp

import { TransitousClient } from "../dist/clients/transitous.js";
import { makeGetTrainStatusTool } from "../dist/tools/get_train_status.js";

const t = new TransitousClient();
const tool = makeGetTrainStatusTool(t);
const regions = {
  "Rhine-Ruhr": [50.85, 6.6, 51.6, 7.9],
  "Rhine-Main": [49.9, 8.4, 50.3, 9.0],
  Berlin: [52.35, 13.1, 52.65, 13.7],
  Hamburg: [53.4, 9.8, 53.7, 10.2],
  Munich: [48.0, 11.3, 48.3, 11.8],
};

const tally = {};
for (const [name, [minLat, minLon, maxLat, maxLon]] of Object.entries(regions)) {
  const trains = await t.getTrainsInArea({ minLat, minLon, maxLat, maxLon });
  const trouble = trains
    .filter((x) => !["TRAM", "SUBWAY"].includes(x.mode) && (x.likelyStuck || x.delayMinutes >= 15))
    .sort((a, b) => b.delayMinutes - a.delayMinutes)
    .slice(0, 3);
  console.log(`\n${name}: ${trains.length} trains, held or 15+ min late: ${trouble.map((x) => `${x.trainName} +${x.delayMinutes}`).join(", ") || "none"}`);
  for (const held of trouble) {
    const from = (await t.searchStations(held.fromStation))[0];
    const to = (await t.searchStations(held.toStation))[0];
    if (!from || !to) continue;
    const board = (await t.getDepartures(from.id, { limit: 30 })).filter(
      (d) => d.tripId !== held.tripId && d.realTime && !["TRAM", "SUBWAY"].includes(d.mode),
    );
    for (const dep of board.slice(0, 8)) {
      const res = await tool.handler({ tripId: dep.tripId, boardLat: to.lat, boardLon: to.lon }).catch(() => null);
      if (!res || !res.mapUrl.includes("&stop=")) continue; // does not run through that stretch
      const line = res.data.lineAhead;
      tally[line.status] = (tally[line.status] ?? 0) + 1;
      if (line.status === "held-up") {
        console.log(`  HELD UP  ${dep.trainName}: ${res.diagram.split("\n").find((l) => l.startsWith("Officially"))}`);
      }
    }
  }
}
console.log(`\nresults: ${JSON.stringify(tally)}`);
