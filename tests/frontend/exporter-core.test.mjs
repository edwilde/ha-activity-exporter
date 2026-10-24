import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PRESET_DAYS,
  buildFilename,
  buildColumns,
  buildJsonPayload,
  chunkRangeByDay,
  computeRange,
  filterRepeats,
  flattenAttributes,
  formatDateForFilename,
  formatTimestamp,
  metadataKeys,
  normaliseRecords,
  parseHistoryRecords,
  sanitizeFilename,
  toCsv,
  toJson,
  wallClockToEpochMs,
} from "../../custom_components/ha_activity_exporter/frontend/exporter-core.js";

// --- chunkRangeByDay ------------------------------------------------------

test("chunkRangeByDay: sub-day range yields one chunk", () => {
  const chunks = chunkRangeByDay(
    "2026-01-15T00:00:00.000Z",
    "2026-01-15T06:00:00.000Z"
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].start, "2026-01-15T00:00:00.000Z");
  assert.equal(chunks[0].end, "2026-01-15T06:00:00.000Z");
});

test("chunkRangeByDay: multi-day range splits on day boundaries and is contiguous", () => {
  const chunks = chunkRangeByDay(
    "2026-01-15T00:00:00.000Z",
    "2026-01-17T12:00:00.000Z"
  );
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].end, chunks[1].start);
  assert.equal(chunks[1].end, chunks[2].start);
  assert.equal(chunks[2].end, "2026-01-17T12:00:00.000Z");
});

test("chunkRangeByDay: invalid / inverted ranges yield no chunks", () => {
  assert.deepEqual(chunkRangeByDay("nope", "also-nope"), []);
  assert.deepEqual(
    chunkRangeByDay("2026-01-17T00:00:00Z", "2026-01-15T00:00:00Z"),
    []
  );
  assert.deepEqual(
    chunkRangeByDay("2026-01-15T00:00:00Z", "2026-01-15T00:00:00Z"),
    []
  );
});

// --- wallClockToEpochMs / computeRange ------------------------------------

test("wallClockToEpochMs: interprets wall clock in the given zone, not the browser", () => {
  // NZST is +12 in May (no DST), IST is +05:30 — independent of process TZ.
  assert.equal(
    wallClockToEpochMs("2026-05-30T08:00", "Pacific/Auckland"),
    Date.UTC(2026, 4, 29, 20, 0, 0)
  );
  assert.equal(
    wallClockToEpochMs("2026-05-30T08:00", "Asia/Kolkata"),
    Date.UTC(2026, 4, 30, 2, 30, 0)
  );
});

test("wallClockToEpochMs: resolves correctly across a DST boundary", () => {
  // 10:00 on 2026-03-08 in New York is already EDT (-4) -> 14:00 UTC.
  assert.equal(
    wallClockToEpochMs("2026-03-08T10:00", "America/New_York"),
    Date.UTC(2026, 2, 8, 14, 0, 0)
  );
});

test("wallClockToEpochMs: no zone falls back to browser-local parsing", () => {
  assert.equal(wallClockToEpochMs("2026-05-30T08:00"), Date.parse("2026-05-30T08:00"));
  assert.ok(Number.isNaN(wallClockToEpochMs("")));
});

test("computeRange: presets are anchored to now; custom uses the HA zone", () => {
  const now = Date.UTC(2026, 0, 15, 0, 0, 0);
  const sevenDays = computeRange("7d", "", "", now, "UTC");
  assert.equal(sevenDays.endMs, now);
  assert.equal(sevenDays.startMs, now - PRESET_DAYS["7d"] * 86400000);

  const custom = computeRange(
    "custom",
    "2026-05-30T08:00",
    "2026-05-31T08:00",
    now,
    "Pacific/Auckland"
  );
  assert.equal(custom.startMs, Date.UTC(2026, 4, 29, 20, 0, 0));
  assert.equal(custom.endMs, Date.UTC(2026, 4, 30, 20, 0, 0));

  const bad = computeRange("nope", "", "", now, "UTC");
  assert.ok(Number.isNaN(bad.startMs) && Number.isNaN(bad.endMs));
});

// --- parseHistoryRecords --------------------------------------------------

// Checks rows are timed by lu, with lc kept separately as lastChangedMs.
test("parseHistoryRecords: times rows by lu and keeps lc as lastChangedMs", () => {
  const result = {
    "binary_sensor.front_door": [
      { s: "on", a: { device_class: "door" }, lu: 1768435200, lc: 1768435100 },
      { s: "off", a: {}, lu: 1768435260 }, // no lc -> lastChanged falls back to lu
    ],
  };
  const records = parseHistoryRecords(result, "binary_sensor.front_door");
  assert.equal(records.length, 2);
  assert.equal(records[0].state, "on");
  assert.equal(records[0].timestampMs, 1768435200 * 1000); // lu wins
  assert.equal(records[0].lastChangedMs, 1768435100 * 1000);
  assert.deepEqual(records[0].attributes, { device_class: "door" });
  assert.equal(records[1].timestampMs, 1768435260 * 1000);
  assert.equal(records[1].lastChangedMs, 1768435260 * 1000); // lc absent -> lu
  assert.deepEqual(records[1].attributes, {});
});

// Checks a settings ramp sharing one lc yields one distinct-time row per step.
test("parseHistoryRecords: a brightness ramp with a shared lc keeps distinct timestamps", () => {
  const T = 1768435000;
  const rows = [10, 20, 30, 40].map((b, i) => ({
    s: "on",
    a: { brightness: b },
    lu: T + 10 + i,
    lc: T,
  }));
  const records = parseHistoryRecords({ light: rows }, "light");
  assert.deepEqual(
    records.map((r) => r.timestampMs),
    [(T + 10) * 1000, (T + 11) * 1000, (T + 12) * 1000, (T + 13) * 1000]
  );
  assert.deepEqual(
    records.map((r) => r.lastChangedMs),
    [T * 1000, T * 1000, T * 1000, T * 1000]
  );
  assert.equal(normaliseRecords(records).length, 4);
});

// Checks a row with no numeric lu is skipped even when lc is present.
test("parseHistoryRecords: skips a row that has lc but no lu", () => {
  const records = parseHistoryRecords(
    { e: [{ s: "on", lc: 1000 }, { s: "off", lu: 2000 }] },
    "e"
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].state, "off");
});

test("parseHistoryRecords: missing entity or attributes handled", () => {
  assert.deepEqual(parseHistoryRecords({}, "sensor.absent"), []);
  const recs = parseHistoryRecords(
    { "sensor.x": [{ s: "5", lu: 1768435200 }] },
    "sensor.x"
  );
  assert.deepEqual(recs[0].attributes, {}); // no "a" key -> {}
  assert.equal(recs[0].state, "5");
});

test("parseHistoryRecords: skips no-timestamp rows, junk entries, and coerces state", () => {
  // A row with neither lu nor lc has no usable time and is skipped.
  const noTime = parseHistoryRecords(
    { e: [{ s: "on" }, { s: "off", lu: 1000 }] },
    "e"
  );
  assert.equal(noTime.length, 1);
  assert.equal(noTime[0].state, "off");

  // null / non-object rows are ignored.
  const junk = parseHistoryRecords({ e: [null, 5, { s: "x", lu: 1 }] }, "e");
  assert.equal(junk.length, 1);
  assert.equal(junk[0].state, "x");

  // numeric/boolean/missing state values are coerced to strings.
  const coerced = parseHistoryRecords(
    { e: [{ s: 0, lu: 1 }, { s: false, lu: 2 }, { lu: 3 }] },
    "e"
  );
  assert.deepEqual(coerced.map((r) => r.state), ["0", "false", ""]);
});

// --- normaliseRecords -----------------------------------------------------

test("normaliseRecords: sorts ascending and drops exact boundary duplicates", () => {
  const input = [
    { timestampMs: 3000, state: "b", attributes: {} },
    { timestampMs: 1000, state: "a", attributes: {} },
    { timestampMs: 3000, state: "b", attributes: {} }, // dup of first
    { timestampMs: 2000, state: "a", attributes: {} },
  ];
  const out = normaliseRecords(input);
  assert.deepEqual(
    out.map((r) => [r.timestampMs, r.state]),
    [
      [1000, "a"],
      [2000, "a"],
      [3000, "b"],
    ]
  );
});

// Checks two rows sharing a time and state but with different settings both survive.
test("normaliseRecords: keeps same-time same-value rows whose attributes differ", () => {
  const out = normaliseRecords([
    { timestampMs: 1000, state: "on", attributes: { brightness: 10 } },
    { timestampMs: 1000, state: "on", attributes: { brightness: 20 } },
  ]);
  assert.deepEqual(
    out.map((r) => r.attributes.brightness),
    [10, 20]
  );
});

// Checks attributes that differ only in key order are treated as the same row.
test("normaliseRecords: drops a duplicate whose attribute keys are in a different order", () => {
  const out = normaliseRecords([
    { timestampMs: 1000, state: "on", attributes: { a: 1, b: { x: 1, y: [1, { p: 1, q: 2 }] } } },
    { timestampMs: 1000, state: "on", attributes: { b: { y: [1, { q: 2, p: 1 }], x: 1 }, a: 1 } },
  ]);
  assert.equal(out.length, 1);
});

test("normaliseRecords: de-dups carried-over state across day chunks (real parse path)", () => {
  const T = 1768435200;
  // Chunk 0 ends with the door "on"; chunk 1's include_start_time_state seed
  // carries the same "on" at the same instant — must collapse to one row.
  const chunk0 = parseHistoryRecords({ e: [{ s: "on", lu: T, lc: T }] }, "e");
  const chunk1 = parseHistoryRecords({ e: [{ s: "on", lu: T }] }, "e");
  const merged = normaliseRecords([...chunk0, ...chunk1]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].state, "on");
});

// --- filterRepeats --------------------------------------------------------

// Checks every setting step is kept and only an exact repeat is dropped.
test("filterRepeats: keeps brightness and colour steps and drops exact repeats", () => {
  const input = [
    { timestampMs: 1, state: "on", attributes: { brightness: 10, rgb_color: [255, 0, 0] } },
    { timestampMs: 2, state: "on", attributes: { brightness: 20, rgb_color: [255, 0, 0] } },
    { timestampMs: 3, state: "on", attributes: { brightness: 20, rgb_color: [255, 0, 0] } }, // exact repeat
    { timestampMs: 4, state: "on", attributes: { brightness: 20, rgb_color: [0, 255, 0] } },
    { timestampMs: 5, state: "off", attributes: {} },
    { timestampMs: 6, state: "off", attributes: {} }, // exact repeat
    { timestampMs: 7, state: "on", attributes: {} },
  ];
  const out = filterRepeats(input);
  assert.deepEqual(
    out.map((r) => r.timestampMs),
    [1, 2, 4, 5, 7]
  );
});

// Checks a change in media position alone counts as a repeat.
test("filterRepeats: a media position only change is a repeat", () => {
  const input = [
    { timestampMs: 1, state: "playing", attributes: { volume_level: 0.5, media_position: 10, media_position_updated_at: "2026-01-01T00:00:00Z" } },
    { timestampMs: 2, state: "playing", attributes: { volume_level: 0.5, media_position: 40, media_position_updated_at: "2026-01-01T00:00:30Z" } },
    { timestampMs: 3, state: "playing", attributes: { volume_level: 0.6, media_position: 70, media_position_updated_at: "2026-01-01T00:01:00Z" } },
  ];
  const out = filterRepeats(input);
  assert.deepEqual(
    out.map((r) => r.timestampMs),
    [1, 3]
  );
});

// Checks attributes with the same content in a different key order are a repeat.
test("filterRepeats: key order does not make attributes differ", () => {
  const input = [
    { timestampMs: 1, state: "on", attributes: { a: 1, b: { x: 1, y: 2 } } },
    { timestampMs: 2, state: "on", attributes: { b: { y: 2, x: 1 }, a: 1 } },
  ];
  assert.equal(filterRepeats(input).length, 1);
});

// Checks a state change with identical attributes is kept.
test("filterRepeats: a value change with identical attributes is kept", () => {
  const input = [
    { timestampMs: 1, state: "on", attributes: { brightness: 10 } },
    { timestampMs: 2, state: "off", attributes: { brightness: 10 } },
  ];
  assert.equal(filterRepeats(input).length, 2);
});

// Checks empty input gives empty output.
test("filterRepeats: empty input -> empty output", () => {
  assert.deepEqual(filterRepeats([]), []);
});

// --- formatTimestamp ------------------------------------------------------

test("formatTimestamp: no time zone falls back to UTC ISO", () => {
  const ms = Date.UTC(2026, 0, 15, 0, 0, 0);
  assert.equal(formatTimestamp(ms), new Date(ms).toISOString());
});

test("formatTimestamp: applies whole-hour offset (NZDT, +13 in January)", () => {
  const ms = Date.UTC(2026, 0, 15, 0, 0, 0);
  assert.equal(formatTimestamp(ms, "Pacific/Auckland"), "2026-01-15T13:00:00+13:00");
});

test("formatTimestamp: applies half-hour offset (IST, +05:30)", () => {
  const ms = Date.UTC(2026, 0, 15, 0, 0, 0);
  assert.equal(formatTimestamp(ms, "Asia/Kolkata"), "2026-01-15T05:30:00+05:30");
});

test("formatTimestamp: DST-crossing records carry different offsets in one zone", () => {
  // US spring-forward is 2026-03-08; the offset flips from -05:00 to -04:00.
  assert.equal(
    formatTimestamp(Date.UTC(2026, 2, 8, 6, 0, 0), "America/New_York"),
    "2026-03-08T01:00:00-05:00"
  );
  assert.equal(
    formatTimestamp(Date.UTC(2026, 2, 8, 8, 0, 0), "America/New_York"),
    "2026-03-08T04:00:00-04:00"
  );
});

test("formatDateForFilename: date portion in the target zone", () => {
  // 23:30 UTC is already the next day in Auckland (+13).
  const ms = Date.UTC(2026, 0, 15, 23, 30, 0);
  assert.equal(formatDateForFilename(ms, "Pacific/Auckland"), "2026-01-16");
});

// --- filename helpers -----------------------------------------------------

test("sanitizeFilename: keeps safe chars, collapses the rest", () => {
  assert.equal(sanitizeFilename("binary_sensor.front_door"), "binary_sensor.front_door");
  assert.equal(sanitizeFilename("a b/c:d"), "a_b_c_d");
  assert.equal(sanitizeFilename("__trim__"), "trim");
});

test("buildFilename: entity + date range + extension", () => {
  const start = Date.UTC(2026, 0, 15, 0, 0, 0);
  const end = Date.UTC(2026, 0, 16, 0, 0, 0);
  assert.equal(
    buildFilename("binary_sensor.front_door", start, end, "csv", "UTC"),
    "binary_sensor.front_door_2026-01-15_2026-01-16.csv"
  );
});

// --- toCsv ----------------------------------------------------------------

test("toCsv: plain-language header, CRLF rows, RFC-4180 escaping of details", () => {
  const records = [
    { timestampMs: Date.UTC(2026, 0, 15, 0, 0, 0), state: "on", attributes: { friendly_name: "Front, Door" } },
  ];
  const csv = toCsv(records, "UTC");
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "timestamp,value,details");
  assert.ok(lines[1].startsWith("2026-01-15T00:00:00+00:00,on,"));
  assert.ok(lines[1].includes('"{""friendly_name"":""Front, Door""}"'));
});

test("toCsv: escapes commas/quotes/newlines in the value", () => {
  const records = [
    { timestampMs: Date.UTC(2026, 0, 15, 0, 0, 0), state: 'a"b,c\nd', attributes: {} },
  ];
  const csv = toCsv(records, "UTC");
  const row = csv.split("\r\n")[1];
  assert.ok(row.includes('"a""b,c\nd"'));
});

test("toCsv: neutralises spreadsheet formula injection", () => {
  const mk = (state) => ({ timestampMs: Date.UTC(2026, 0, 15, 0, 0, 0), state, attributes: {} });
  const rows = toCsv([mk("=SUM(1+1)"), mk("+1"), mk("-5"), mk("@x"), mk("on")], "UTC").split("\r\n");
  assert.equal(rows[1], "2026-01-15T00:00:00+00:00,'=SUM(1+1),{}");
  assert.equal(rows[2], "2026-01-15T00:00:00+00:00,'+1,{}");
  assert.equal(rows[3], "2026-01-15T00:00:00+00:00,'-5,{}");
  assert.equal(rows[4], "2026-01-15T00:00:00+00:00,'@x,{}");
  assert.equal(rows[5], "2026-01-15T00:00:00+00:00,on,{}"); // benign value untouched
});

test("toCsv: empty records yields the header line only", () => {
  assert.equal(toCsv([], "UTC"), "timestamp,value,details");
});

// --- toJson / buildJsonPayload --------------------------------------------

test("buildJsonPayload: self-describing wrapper shape (machine schema keeps HA names)", () => {
  const records = [
    { timestampMs: Date.UTC(2026, 0, 15, 1, 0, 0), state: "on", attributes: { device_class: "door" } },
    { timestampMs: Date.UTC(2026, 0, 15, 2, 0, 0), state: "off", attributes: {} },
  ];
  const payload = buildJsonPayload(
    {
      entityId: "binary_sensor.front_door",
      friendlyName: "Front Door",
      exportedAtMs: Date.UTC(2026, 0, 16, 0, 0, 0),
      periodStartMs: Date.UTC(2026, 0, 15, 0, 0, 0),
      periodEndMs: Date.UTC(2026, 0, 16, 0, 0, 0),
      stateChangesOnly: true,
    },
    records,
    "UTC"
  );
  assert.equal(payload.entity_id, "binary_sensor.front_door");
  assert.equal(payload.friendly_name, "Front Door");
  assert.equal(payload.state_changes_only, true);
  assert.equal(payload.record_count, 2);
  assert.equal(payload.period.start, "2026-01-15T00:00:00+00:00");
  assert.equal(payload.period.end, "2026-01-16T00:00:00+00:00");
  assert.deepEqual(payload.records[0], {
    timestamp: "2026-01-15T01:00:00+00:00",
    state: "on",
    attributes: { device_class: "door" },
  });
});

test("toJson: produces valid, pretty-printed JSON", () => {
  const json = toJson(
    {
      entityId: "sensor.x",
      friendlyName: null,
      exportedAtMs: 0,
      periodStartMs: 0,
      periodEndMs: 1000,
      stateChangesOnly: false,
    },
    [],
    "UTC"
  );
  assert.ok(json.includes("\n  ")); // pretty printed
  const parsed = JSON.parse(json);
  assert.equal(parsed.record_count, 0);
  assert.equal(parsed.friendly_name, null);
});

// --- settings columns -----------------------------------------------------

/** Build normalised records from compressed rows {s, a, lu}. */
function recordsFrom(rows) {
  return parseHistoryRecords({ "x.y": rows }, "x.y");
}

const LIGHT_META = {
  friendly_name: "Bedside",
  supported_color_modes: ["color_temp", "hs", "xy"],
  supported_features: 40,
  min_color_temp_kelvin: 2000,
  max_color_temp_kelvin: 6535,
  min_mireds: 153,
  max_mireds: 500,
};

// A light on in hs mode gives hue, saturation and a derived brightness percent
test("flattenAttributes: hs light gives hue, saturation and brightness_percent 1.2 for brightness 3", () => {
  const records = recordsFrom([
    { s: "on", lu: 1, a: { ...LIGHT_META, brightness: 3, color_mode: "hs", hs_color: [27.5, 63.2] } },
  ]);
  const metadata = metadataKeys(records);
  const { cells, leftovers } = flattenAttributes(records[0].attributes, metadata);
  assert.deepEqual(cells, {
    brightness: 3,
    brightness_percent: 1.2,
    color_mode: "hs",
    hue: 27.5,
    saturation: 63.2,
  });
  assert.deepEqual(leftovers, {});
});

// A colour-mode switch fills color_temp_kelvin first, then hue and saturation
test("buildColumns: colour-mode switch fills color_temp_kelvin then hue and saturation", () => {
  const records = recordsFrom([
    { s: "on", lu: 1, a: { ...LIGHT_META, brightness: 255, color_mode: "color_temp", color_temp_kelvin: 2700, hs_color: null } },
    { s: "on", lu: 2, a: { ...LIGHT_META, brightness: 128, color_mode: "hs", color_temp_kelvin: null, hs_color: [30, 70] } },
  ]);
  const metadata = metadataKeys(records);
  assert.deepEqual(buildColumns(records, metadata), [
    "brightness",
    "brightness_percent",
    "color_mode",
    "color_temp_kelvin",
    "hue",
    "saturation",
  ]);
  assert.deepEqual(flattenAttributes(records[0].attributes, metadata).cells, {
    brightness: 255,
    brightness_percent: 100,
    color_mode: "color_temp",
    color_temp_kelvin: 2700,
  });
  assert.deepEqual(flattenAttributes(records[1].attributes, metadata).cells, {
    brightness: 128,
    brightness_percent: 50.2,
    color_mode: "hs",
    hue: 30,
    saturation: 70,
  });
});

// An off light (settings all null) leaves every light cell blank
test("flattenAttributes: an off light row has no cells and no leftovers", () => {
  const records = recordsFrom([
    { s: "off", lu: 1, a: { ...LIGHT_META, brightness: null, color_mode: null, color_temp_kelvin: null, hs_color: null, rgb_color: null, xy_color: null } },
  ]);
  const { cells, leftovers } = flattenAttributes(records[0].attributes, metadataKeys(records));
  assert.deepEqual(cells, {});
  assert.deepEqual(leftovers, {});
});

// An rgbw light without rgb_color takes red/green/blue/white from rgbw_color, zero kept
test("flattenAttributes: rgbw without rgb_color gives red, green, blue, white and nothing left over", () => {
  const records = recordsFrom([
    { s: "on", lu: 1, a: { ...LIGHT_META, brightness: 255, color_mode: "rgbw", rgbw_color: [165, 136, 0, 88] } },
  ]);
  const { cells, leftovers } = flattenAttributes(records[0].attributes, metadataKeys(records));
  assert.deepEqual(cells, {
    brightness: 255,
    brightness_percent: 100,
    color_mode: "rgbw",
    red: 165,
    green: 136,
    blue: 0,
    white: 88,
  });
  assert.deepEqual(leftovers, {});
});

// With rgb_color present, rgbw_color keeps its raw values in leftovers but still supplies white
test("flattenAttributes: rgbw with rgb_color keeps rgbw_color in leftovers", () => {
  const records = recordsFrom([
    { s: "on", lu: 1, a: { ...LIGHT_META, color_mode: "rgbw", rgb_color: [255, 200, 100], rgbw_color: [250, 190, 90, 50] } },
  ]);
  const { cells, leftovers } = flattenAttributes(records[0].attributes, metadataKeys(records));
  assert.deepEqual(cells, { color_mode: "rgbw", red: 255, green: 200, blue: 100, white: 50 });
  assert.deepEqual(leftovers, { rgbw_color: [250, 190, 90, 50] });
});

// rgbww and xy tuples split into their named columns
test("flattenAttributes: rgbww and xy tuples split into named columns", () => {
  const records = recordsFrom([
    { s: "on", lu: 1, a: { rgbww_color: [10, 20, 30, 40, 50], xy_color: [0.5, 0.25] } },
  ]);
  const { cells, leftovers } = flattenAttributes(records[0].attributes, metadataKeys(records));
  assert.deepEqual(cells, {
    red: 10,
    green: 20,
    blue: 30,
    cold_white: 40,
    warm_white: 50,
    x: 0.5,
    y: 0.25,
  });
  assert.deepEqual(leftovers, {});
});

// A tuple of the wrong length or with non-numeric members is left in leftovers unchanged
test("flattenAttributes: malformed tuples go to leftovers without partial cells", () => {
  const { cells, leftovers } = flattenAttributes(
    { hs_color: [30], rgb_color: [1, "2", 3], xy_color: [0.1, 0.2, 0.3] },
    new Set()
  );
  assert.deepEqual(cells, {});
  assert.deepEqual(leftovers, { hs_color: [30], rgb_color: [1, "2", 3], xy_color: [0.1, 0.2, 0.3] });
});

// A non-numeric brightness is kept as given and gets no derived percent
test("flattenAttributes: non-numeric brightness has no brightness_percent", () => {
  const { cells } = flattenAttributes({ brightness: "high" }, new Set());
  assert.deepEqual(cells, { brightness: "high" });
});

// Thermostat settings become columns while capability attributes do not
test("buildColumns: thermostat settings are columns, hvac_modes and min_temp are not", () => {
  const attrs = {
    friendly_name: "Hallway",
    hvac_modes: ["off", "heat"],
    min_temp: 7,
    max_temp: 35,
    target_temp_step: 0.5,
    supported_features: 17,
  };
  const records = recordsFrom([
    { s: "heat", lu: 1, a: { ...attrs, current_temperature: -3.5, temperature: 21, hvac_action: "heating" } },
    { s: "heat", lu: 2, a: { ...attrs, current_temperature: -3, temperature: 21, hvac_action: "idle" } },
  ]);
  const metadata = metadataKeys(records);
  assert.deepEqual([...metadata].sort(), [
    "friendly_name",
    "hvac_modes",
    "max_temp",
    "min_temp",
    "supported_features",
    "target_temp_step",
  ]);
  assert.deepEqual(buildColumns(records, metadata), ["current_temperature", "hvac_action", "temperature"]);
  const { cells, leftovers } = flattenAttributes(records[0].attributes, metadata);
  assert.deepEqual(cells, { current_temperature: -3.5, hvac_action: "heating", temperature: 21 });
  assert.deepEqual(leftovers, {});
});

// A metadata-looking attribute that varies gets a column, while a constant sibling stays metadata
test("metadataKeys: a varying max_value is not metadata but a constant min_value is", () => {
  const records = recordsFrom([
    { s: "3", lu: 1, a: { min_value: 0, max_value: 5 } },
    { s: "4", lu: 2, a: { min_value: 0, max_value: 7 } },
  ]);
  const metadata = metadataKeys(records);
  assert.deepEqual([...metadata], ["min_value"]);
  assert.deepEqual(buildColumns(records, metadata), ["max_value"]);
  assert.deepEqual(flattenAttributes(records[1].attributes, metadata).cells, { max_value: 7 });
});

// A known metadata name that varies (friendly_name renamed) also gets a column
test("metadataKeys: a renamed friendly_name is not metadata", () => {
  const records = recordsFrom([
    { s: "on", lu: 1, a: { friendly_name: "Lamp" } },
    { s: "on", lu: 2, a: { friendly_name: "Lamp 2" } },
  ]);
  const metadata = metadataKeys(records);
  assert.equal(metadata.size, 0);
  assert.deepEqual(buildColumns(records, metadata), ["friendly_name"]);
});

// Records lacking a metadata key are ignored when checking it is constant
test("metadataKeys: records without the key do not make it vary", () => {
  const records = recordsFrom([
    { s: "on", lu: 1, a: { icon: "mdi:lamp" } },
    { s: "on", lu: 2, a: {} },
    { s: "on", lu: 3, a: { icon: "mdi:lamp" } },
  ]);
  assert.deepEqual([...metadataKeys(records)], ["icon"]);
});

// A plain sensor carrying only descriptive attributes yields no extra columns
test("buildColumns: a sensor with only metadata has no attribute columns", () => {
  const meta = { friendly_name: "Outdoor", unit_of_measurement: "C", device_class: "temperature", state_class: "measurement" };
  const records = recordsFrom([
    { s: "-3.5", lu: 1, a: meta },
    { s: "-3.0", lu: 2, a: meta },
  ]);
  const metadata = metadataKeys(records);
  assert.equal(metadata.size, 4);
  assert.deepEqual(buildColumns(records, metadata), []);
});

// Objects go to leftovers, scalar lists become compact JSON, nulls are dropped
test("flattenAttributes: objects to leftovers, scalar lists to JSON text, nulls omitted", () => {
  const { cells, leftovers } = flattenAttributes(
    {
      effect_list: ["a", "b"],
      tags: ["a", 2, true],
      none: [],
      nothing: null,
      flag: false,
      nested: { a: 1 },
      mixed: [{ a: 1 }],
      grid: [[1, 2]],
    },
    new Set(["effect_list"])
  );
  assert.deepEqual(cells, { tags: '["a",2,true]', none: "[]", flag: false });
  assert.deepEqual(leftovers, { nested: { a: 1 }, mixed: [{ a: 1 }], grid: [[1, 2]] });
});

// Attributes named like a fixed column are prefixed in both cells and columns
test("flattenAttributes and buildColumns: fixed-column names get the attribute_ prefix", () => {
  const records = recordsFrom([
    { s: "on", lu: 1, a: { value: 1, timestamp: "t", details: "d", changed_by: "me", seconds_since_previous: 9, zeta: 1 } },
  ]);
  const metadata = metadataKeys(records);
  assert.deepEqual(flattenAttributes(records[0].attributes, metadata).cells, {
    attribute_value: 1,
    attribute_timestamp: "t",
    attribute_details: "d",
    attribute_changed_by: "me",
    attribute_seconds_since_previous: 9,
    zeta: 1,
  });
  assert.deepEqual(buildColumns(records, metadata), [
    "attribute_changed_by",
    "attribute_details",
    "attribute_seconds_since_previous",
    "attribute_timestamp",
    "attribute_value",
    "zeta",
  ]);
});

// Light columns come first in briefing order, then other columns alphabetically
test("buildColumns: light columns precede the alphabetical rest", () => {
  const records = recordsFrom([
    { s: "on", lu: 1, a: { effect: "rainbow", brightness: 10, color_mode: "xy", xy_color: [0.1, 0.2], rgbww_color: [1, 2, 3, 4, 5], rgbw_color: [1, 2, 3, 4], hs_color: [1, 2], color_temp_kelvin: 3000, alpha: 1 } },
  ]);
  assert.deepEqual(buildColumns(records, metadataKeys(records)), [
    "brightness",
    "brightness_percent",
    "color_mode",
    "color_temp_kelvin",
    "hue",
    "saturation",
    "red",
    "green",
    "blue",
    "white",
    "cold_white",
    "warm_white",
    "x",
    "y",
    "alpha",
    "effect",
  ]);
});

// A column whose only values are empty strings is not included
test("buildColumns: an attribute that is always an empty string gets no column", () => {
  const records = recordsFrom([
    { s: "on", lu: 1, a: { effect: "" } },
    { s: "on", lu: 2, a: { effect: "" } },
  ]);
  assert.deepEqual(buildColumns(records, metadataKeys(records)), []);
});
