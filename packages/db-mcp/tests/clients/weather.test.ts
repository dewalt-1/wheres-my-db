import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../setup.js";
import { WeatherClient } from "../../src/clients/weather.js";
import { ProviderError } from "../../src/errors.js";
import fixture from "../fixtures/dwd-warnings-point.json" with { type: "json" };

const URL_ = "https://maps.dwd.de/geoserver/dwd/ows";
const MUNICH = { lat: 48.137, lon: 11.575 };
// The fixture holds one FROST warning: 2026-11-13T19:00Z to 2026-11-14T08:00Z.
const DURING = "2026-11-13T22:00:00Z";

function feature(props: Record<string, unknown>) {
  return { type: "Feature", properties: { ...fixture.features[0].properties, ...props } };
}

function isDwdError(kind: string) {
  return (err: unknown) => err instanceof ProviderError && err.source === "dwd" && err.kind === kind;
}

describe("WeatherClient.getWarningsNear", () => {
  it("asks for the district containing the point, lon before lat, and maps the warning", async () => {
    mswServer.use(
      http.get(URL_, ({ request }) => {
        const q = new URL(request.url).searchParams;
        expect(q.get("typeName")).toBe("dwd:Warnungen_Landkreise");
        expect(q.get("version")).toBe("1.0.0");
        expect(q.get("CQL_FILTER")).toBe("INTERSECTS(THE_GEOM, POINT(11.575 48.137))");
        return HttpResponse.json(fixture);
      }),
    );
    const { warnings } = await new WeatherClient().getWarningsNear(MUNICH, DURING);
    expect(warnings).toEqual([
      {
        type: "FROST",
        level: 1,
        headline: "Amtliche WARNUNG vor FROST",
        description: fixture.features[0].properties.DESCRIPTION,
        start: "2026-11-13T19:00:00.000Z",
        end: "2026-11-14T08:00:00.000Z",
        areaName: fixture.features[0].properties.AREADESC,
      },
    ]);
  });

  it("maps DWD severity words to levels 1-4", async () => {
    mswServer.use(
      http.get(URL_, () =>
        HttpResponse.json({
          features: [
            feature({ EVENT: "A", SEVERITY: "Minor" }),
            feature({ EVENT: "B", SEVERITY: "Moderate" }),
            feature({ EVENT: "C", SEVERITY: "Severe" }),
            feature({ EVENT: "D", SEVERITY: "Extreme" }),
            feature({ EVENT: "E", SEVERITY: "Unknown" }),
          ],
        }),
      ),
    );
    const { warnings } = await new WeatherClient().getWarningsNear(MUNICH, DURING);
    expect(warnings.map((w) => [w.type, w.level])).toEqual([["A", 1], ["B", 2], ["C", 3], ["D", 4]]);
  });

  it("with atTime, drops warnings not in force at that moment", async () => {
    mswServer.use(http.get(URL_, () => HttpResponse.json(fixture)));
    const client = new WeatherClient();
    expect((await client.getWarningsNear(MUNICH, "2026-11-13T18:00:00Z")).warnings).toEqual([]);
    expect((await client.getWarningsNear(MUNICH, "2026-11-14T09:00:00Z")).warnings).toEqual([]);
  });

  it("without atTime, keeps upcoming warnings and drops expired ones", async () => {
    const future = new Date(Date.now() + 6 * 3600_000).toISOString();
    const later = new Date(Date.now() + 12 * 3600_000).toISOString();
    const past = new Date(Date.now() - 6 * 3600_000).toISOString();
    const earlier = new Date(Date.now() - 12 * 3600_000).toISOString();
    mswServer.use(
      http.get(URL_, () =>
        HttpResponse.json({
          features: [
            feature({ EVENT: "UPCOMING", ONSET: future, EXPIRES: later }),
            feature({ EVENT: "EXPIRED", ONSET: earlier, EXPIRES: past }),
          ],
        }),
      ),
    );
    const { warnings } = await new WeatherClient().getWarningsNear(MUNICH);
    expect(warnings.map((w) => w.type)).toEqual(["UPCOMING"]);
  });

  it("returns an empty list when no warning covers the point", async () => {
    mswServer.use(http.get(URL_, () => HttpResponse.json({ type: "FeatureCollection", features: [] })));
    expect((await new WeatherClient().getWarningsNear(MUNICH)).warnings).toEqual([]);
  });

  it("throws typed errors for HTTP failure, timeout and a malformed body", async () => {
    mswServer.use(http.get(URL_, () => new HttpResponse("boom", { status: 503 })));
    await expect(new WeatherClient().getWarningsNear(MUNICH)).rejects.toSatisfy(isDwdError("http"));

    mswServer.use(
      http.get(URL_, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json(fixture);
      }),
    );
    await expect(new WeatherClient({ timeoutMs: 30 }).getWarningsNear(MUNICH)).rejects.toSatisfy(isDwdError("timeout"));

    mswServer.use(http.get(URL_, () => HttpResponse.json({ nope: true })));
    await expect(new WeatherClient().getWarningsNear(MUNICH)).rejects.toSatisfy(isDwdError("parse"));
  });
});
