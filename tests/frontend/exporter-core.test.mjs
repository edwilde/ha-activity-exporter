import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PRESET_DAYS,
  attachCauses,
  buildFilename,
  buildCacheKey,
  buildColumns,
  buildExportGroups,
  buildJsonPayload,
  buildMultiFilename,
  buildMultiJsonPayload,
  chunkRangeByDay,
  computeRange,
  describeCause,
  describeMissingHistory,
  filterRepeats,
  flattenAttributes,
  formatDateForFilename,
  formatTimestamp,
  metadataKeys,
  normaliseRecords,
  parseHistoryRecords,
  parseLogbookEntries,
  sanitizeFilename,
  secondsSincePrevious,
  toCsv,
  toJson,
  toMultiCsv,
  toMultiJson,
  userNamesFromStates,
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

// Checks an interleaved duplicate at the same time (A, B, A) is dropped.
test("normaliseRecords: drops a duplicate separated from its twin by another row at the same time", () => {
  const out = normaliseRecords([
    { timestampMs: 1000, state: "on", attributes: { brightness: 10 } },
    { timestampMs: 1000, state: "on", attributes: { brightness: 20 } },
    { timestampMs: 1000, state: "on", attributes: { brightness: 10 } },
  ]);
  assert.deepEqual(
    out.map((r) => r.attributes.brightness),
    [10, 20]
  );
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

// Checks rows missing the volatile attributes, or all attributes, compare by what remains.
test("filterRepeats: a row lacking media position or attributes is compared on the rest", () => {
  const input = [
    { timestampMs: 1, state: "playing", attributes: { volume_level: 0.5, media_position: 10, media_position_updated_at: "2026-01-01T00:00:00Z" } },
    { timestampMs: 2, state: "playing", attributes: { volume_level: 0.5 } }, // repeat of 1
    { timestampMs: 3, state: "idle", attributes: {} },
    { timestampMs: 4, state: "idle", attributes: undefined }, // repeat of 3
    { timestampMs: 5, state: "idle", attributes: { volume_level: 0.5 } },
  ];
  const out = filterRepeats(input);
  assert.deepEqual(
    out.map((r) => r.timestampMs),
    [1, 3, 5]
  );
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

// Checks the legacy three-column layout, CRLF rows and RFC-4180 escaping of details.
test("toCsv: legacy layout has a plain-language header, CRLF rows and escaped details", () => {
  const records = [
    { timestampMs: Date.UTC(2026, 0, 15, 0, 0, 0), state: "on", attributes: { friendly_name: "Front, Door" } },
  ];
  const csv = toCsv(records, "UTC", { splitColumns: false });
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "timestamp,value,details");
  assert.ok(lines[1].startsWith("2026-01-15T00:00:00+00:00,on,"));
  assert.ok(lines[1].includes('"{""friendly_name"":""Front, Door""}"'));
});

// Checks commas, quotes and newlines in the value are quoted in the legacy layout.
test("toCsv: legacy layout escapes commas, quotes and newlines in the value", () => {
  const records = [
    { timestampMs: Date.UTC(2026, 0, 15, 0, 0, 0), state: 'a"b,c\nd', attributes: {} },
  ];
  const csv = toCsv(records, "UTC", { splitColumns: false });
  const row = csv.split("\r\n")[1];
  assert.ok(row.includes('"a""b,c\nd"'));
});

// Checks formula-leading text is prefixed in the legacy layout while numbers are left alone.
test("toCsv: legacy layout neutralises spreadsheet formula injection but keeps numbers", () => {
  const mk = (state) => ({ timestampMs: Date.UTC(2026, 0, 15, 0, 0, 0), state, attributes: {} });
  const rows = toCsv([mk("=SUM(1+1)"), mk("+1"), mk("-x"), mk("@x"), mk("on"), mk("-5")], "UTC", { splitColumns: false }).split("\r\n");
  assert.equal(rows[1], "2026-01-15T00:00:00+00:00,'=SUM(1+1),{}");
  assert.equal(rows[2], "2026-01-15T00:00:00+00:00,'+1,{}");
  assert.equal(rows[3], "2026-01-15T00:00:00+00:00,'-x,{}");
  assert.equal(rows[4], "2026-01-15T00:00:00+00:00,'@x,{}");
  assert.equal(rows[5], "2026-01-15T00:00:00+00:00,on,{}"); // benign value untouched
  assert.equal(rows[6], "2026-01-15T00:00:00+00:00,-5,{}"); // a negative number stays numeric
});

// Checks empty input gives only the legacy header.
test("toCsv: legacy layout with empty records yields the header line only", () => {
  assert.equal(toCsv([], "UTC", { splitColumns: false }), "timestamp,value,details");
});

// --- toJson / buildJsonPayload --------------------------------------------

test("buildJsonPayload: self-describing wrapper shape (machine schema keeps HA names)", () => {
  const records = [
    { timestampMs: Date.UTC(2026, 0, 15, 1, 0, 0), lastChangedMs: Date.UTC(2026, 0, 15, 1, 0, 0), state: "on", attributes: { device_class: "door" } },
    { timestampMs: Date.UTC(2026, 0, 15, 2, 0, 0), lastChangedMs: Date.UTC(2026, 0, 15, 2, 0, 0), state: "off", attributes: {} },
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
    last_changed: "2026-01-15T01:00:00+00:00",
    state: "on",
    attributes: { device_class: "door" },
    derived: { state_changed: true, seconds_since_previous: null },
  });
  assert.deepEqual(payload.records[1].derived, { state_changed: true, seconds_since_previous: 3600 });
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

// --- split CSV ------------------------------------------------------------

const BASE = 1768435200; // 2026-01-15T00:00:00Z

/** Bedside light rows: a value change then two settings-only steps. */
function bedsideRecords() {
  return recordsFrom([
    { s: "on", lu: BASE, a: { ...LIGHT_META, brightness: 3, color_mode: "hs", hs_color: [27.5, 63.2], rgb_color: [255, 150, 100], xy_color: [0.5, 0.4] } },
    { s: "on", lu: BASE + 30, lc: BASE, a: { ...LIGHT_META, brightness: 20, color_mode: "hs", hs_color: [28, 63.2], rgb_color: [255, 152, 100], xy_color: [0.5, 0.4] } },
    { s: "on", lu: BASE + 60.25, lc: BASE, a: { ...LIGHT_META, brightness: 255, color_mode: "hs", hs_color: [30, 70], rgb_color: [255, 170, 76], xy_color: [0.45, 0.41] } },
  ]);
}

// Checks the secondsSincePrevious helper returns null first, then a 3 decimal place gap.
test("secondsSincePrevious: null for the first record and the gap rounded to 3 decimals after", () => {
  const records = [{ timestampMs: 0 }, { timestampMs: 1234.5678 }, { timestampMs: 31234.5678 }];
  assert.equal(secondsSincePrevious(records, 0), null);
  assert.equal(secondsSincePrevious(records, 1), 1.235);
  assert.equal(secondsSincePrevious(records, 2), 30);
});

// Checks the bedside light gives the exact split header and rows, settings-only steps included.
test("toCsv: split layout writes the bedside light's settings in named columns", () => {
  const rows = toCsv(bedsideRecords(), "UTC").split("\r\n");
  assert.equal(
    rows[0],
    "timestamp,value,seconds_since_previous,brightness,brightness_percent,color_mode,hue,saturation,red,green,blue,x,y,details"
  );
  assert.equal(rows[1], "2026-01-15T00:00:00+00:00,on,,3,1.2,hs,27.5,63.2,255,150,100,0.5,0.4,");
  assert.equal(rows[2], "2026-01-15T00:00:30+00:00,on,30,20,7.8,hs,28,63.2,255,152,100,0.5,0.4,");
  assert.equal(rows[3], "2026-01-15T00:01:00+00:00,on,30.25,255,100,hs,30,70,255,170,76,0.45,0.41,");
  assert.equal(rows.length, 4);
});

// Checks split is the default and an explicit true gives the same output.
test("toCsv: split layout is the default", () => {
  const records = bedsideRecords();
  assert.equal(toCsv(records, "UTC"), toCsv(records, "UTC", { splitColumns: true }));
  assert.notEqual(toCsv(records, "UTC"), toCsv(records, "UTC", { splitColumns: false }));
});

// Checks details holds the compact JSON of leftovers and is blank when there are none.
test("toCsv: split layout puts leftovers in details and leaves it blank otherwise", () => {
  const records = recordsFrom([
    { s: "on", lu: BASE, a: { color_mode: "rgbw", rgb_color: [255, 200, 100], rgbw_color: [250, 190, 90, 50] } },
    { s: "off", lu: BASE + 5, a: {} },
  ]);
  const rows = toCsv(records, "UTC").split("\r\n");
  assert.equal(rows[0], "timestamp,value,seconds_since_previous,color_mode,red,green,blue,white,details");
  assert.equal(rows[1], '2026-01-15T00:00:00+00:00,on,,rgbw,255,200,100,50,"{""rgbw_color"":[250,190,90,50]}"');
  assert.equal(rows[2], "2026-01-15T00:00:05+00:00,off,5,,,,,,");
});

// Checks negative numbers in a column and in the value stay numeric.
test("toCsv: split layout keeps -3.5 numeric in a column and as the value", () => {
  const thermostat = recordsFrom([
    { s: "heat", lu: BASE, a: { friendly_name: "Hall", hvac_modes: ["off", "heat"], current_temperature: -3.5, temperature: 21, hvac_action: "heating" } },
  ]);
  assert.deepEqual(toCsv(thermostat, "UTC").split("\r\n"), [
    "timestamp,value,seconds_since_previous,current_temperature,hvac_action,temperature,details",
    "2026-01-15T00:00:00+00:00,heat,,-3.5,heating,21,",
  ]);
  const sensor = recordsFrom([
    { s: "-3.5", lu: BASE, a: { unit_of_measurement: "C" } },
    { s: "-3.0", lu: BASE + 60, a: { unit_of_measurement: "C" } },
  ]);
  assert.deepEqual(toCsv(sensor, "UTC").split("\r\n"), [
    "timestamp,value,seconds_since_previous,details",
    "2026-01-15T00:00:00+00:00,-3.5,,",
    "2026-01-15T00:01:00+00:00,-3.0,60,",
  ]);
});

// Checks formula-leading text in the value and in a column is still prefixed.
test("toCsv: split layout still neutralises =cmd and other formula text", () => {
  const records = recordsFrom([
    { s: "=cmd", lu: BASE, a: { effect: "=cmd", note: "-abc", other: "+1", num: "-5abc", neg: "-1.5e-3" } },
  ]);
  const rows = toCsv(records, "UTC").split("\r\n");
  assert.equal(rows[0], "timestamp,value,seconds_since_previous,effect,neg,note,num,other,details");
  assert.equal(rows[1], "2026-01-15T00:00:00+00:00,'=cmd,,'=cmd,-1.5e-3,'-abc,'-5abc,'+1,");
});

// Checks header names that need quoting or neutralising go through the same escaping as the rows.
test("toCsv: split layout escapes attribute names in the header row", () => {
  const records = recordsFrom([{ s: "on", lu: BASE, a: { "a,b": 1, "=cmd": 2 } }]);
  const rows = toCsv(records, "UTC").split("\r\n");
  assert.equal(rows[0], "timestamp,value,seconds_since_previous,'=cmd,\"a,b\",details");
  assert.equal(rows[1], "2026-01-15T00:00:00+00:00,on,,2,1,");
});

// Checks a real attribute named attribute_<name> goes to details instead of overwriting the renamed cell.
test("flattenAttributes and toCsv: a colliding attribute_ name goes to details", () => {
  const records = recordsFrom([{ s: "on", lu: BASE, a: { value: 1, attribute_value: 2 } }]);
  const { cells, leftovers } = flattenAttributes(records[0].attributes, metadataKeys(records));
  assert.deepEqual(cells, { attribute_value: 1 });
  assert.deepEqual(leftovers, { attribute_value: 2 });
  const rows = toCsv(records, "UTC").split("\r\n");
  assert.equal(rows[0], "timestamp,value,seconds_since_previous,attribute_value,details");
  assert.equal(rows[1], '2026-01-15T00:00:00+00:00,on,,1,"{""attribute_value"":2}"');
});

// Checks a constant humidifier mode is a setting and gets its own column.
test("toCsv: a humidifier's constant mode gets a column", () => {
  const records = recordsFrom([
    { s: "on", lu: BASE, a: { mode: "auto", humidity: 50 } },
    { s: "on", lu: BASE + 60, lc: BASE, a: { mode: "auto", humidity: 55 } },
  ]);
  assert.deepEqual(toCsv(records, "UTC").split("\r\n"), [
    "timestamp,value,seconds_since_previous,humidity,mode,details",
    "2026-01-15T00:00:00+00:00,on,,50,auto,",
    "2026-01-15T00:01:00+00:00,on,60,55,auto,",
  ]);
});

// Checks empty input gives the split header with no attribute columns.
test("toCsv: split layout with empty records yields the header line only", () => {
  assert.equal(toCsv([], "UTC"), "timestamp,value,seconds_since_previous,details");
});

// --- JSON entity and derived ----------------------------------------------

const JSON_META = {
  entityId: "light.bedside",
  friendlyName: "Bedside",
  exportedAtMs: (BASE + 3600) * 1000,
  periodStartMs: (BASE - 600) * 1000,
  periodEndMs: (BASE + 3600) * 1000,
  stateChangesOnly: false,
};

// Checks the entity block carries id, name, domain and capabilities.
test("buildJsonPayload: entity block has entity_id, friendly_name, domain and capabilities", () => {
  const payload = buildJsonPayload(JSON_META, bedsideRecords(), "UTC");
  assert.deepEqual(payload.entity, {
    entity_id: "light.bedside",
    friendly_name: "Bedside",
    domain: "light",
    capabilities: {
      friendly_name: "Bedside",
      supported_color_modes: ["color_temp", "hs", "xy"],
      supported_features: 40,
      min_color_temp_kelvin: 2000,
      max_color_temp_kelvin: 6535,
      min_mireds: 153,
      max_mireds: 500,
    },
  });
  assert.equal(payload.entity_id, "light.bedside");
});

// Checks capabilities take each key from the latest record that has it.
test("buildJsonPayload: capabilities come from the latest record that has each key", () => {
  const records = recordsFrom([
    { s: "on", lu: BASE, a: { icon: "mdi:lamp", supported_color_modes: ["hs"] } },
    { s: "off", lu: BASE + 10, a: { supported_color_modes: ["hs"] } },
  ]);
  const payload = buildJsonPayload(JSON_META, records, "UTC");
  assert.deepEqual(payload.entity.capabilities, { icon: "mdi:lamp", supported_color_modes: ["hs"] });
});

// Checks a null friendly name, no dot in the id and no records.
test("buildJsonPayload: entity block handles a missing name, a dotless id and no records", () => {
  const payload = buildJsonPayload({ ...JSON_META, entityId: "plain", friendlyName: undefined }, [], "UTC");
  assert.deepEqual(payload.entity, { entity_id: "plain", friendly_name: null, domain: "plain", capabilities: {} });
  assert.equal(buildJsonPayload({ ...JSON_META, entityId: "a.b.c" }, [], "UTC").entity.domain, "a");
});

// Checks a settings-only row reads state_changed false and carries derived values.
test("buildJsonPayload: settings-only rows have state_changed false and exact derived values", () => {
  const payload = buildJsonPayload(JSON_META, bedsideRecords(), "UTC");
  assert.deepEqual(payload.records.map((r) => r.derived), [
    { state_changed: true, seconds_since_previous: null, brightness_percent: 1.2 },
    { state_changed: false, seconds_since_previous: 30, brightness_percent: 7.8 },
    { state_changed: false, seconds_since_previous: 30.25, brightness_percent: 100 },
  ]);
  assert.deepEqual(payload.records[1].attributes, bedsideRecords()[1].attributes);
});

// Checks brightness_percent is left out unless brightness is a finite number.
test("buildJsonPayload: brightness_percent is only present for a numeric brightness", () => {
  const records = recordsFrom([
    { s: "off", lu: BASE, a: { brightness: null } },
    { s: "on", lu: BASE + 1, a: { brightness: "high" } },
    { s: "on", lu: BASE + 2, a: { brightness: 0 } },
    { s: "on", lu: BASE + 3, a: {} },
  ]);
  const derived = buildJsonPayload(JSON_META, records, "UTC").records.map((r) => r.derived);
  assert.deepEqual(derived[0], { state_changed: true, seconds_since_previous: null });
  assert.deepEqual(derived[1], { state_changed: true, seconds_since_previous: 1 });
  assert.deepEqual(derived[2], { state_changed: true, seconds_since_previous: 1, brightness_percent: 0 });
  assert.deepEqual(derived[3], { state_changed: true, seconds_since_previous: 1 });
});

// Checks last_changed is the row's own time for a value change and the earlier lc for a settings-only step.
test("buildJsonPayload: each record carries last_changed from lc", () => {
  const records = buildJsonPayload(JSON_META, bedsideRecords(), "UTC").records;
  assert.deepEqual(
    records.map((r) => [r.timestamp, r.last_changed]),
    [
      ["2026-01-15T00:00:00+00:00", "2026-01-15T00:00:00+00:00"],
      ["2026-01-15T00:00:30+00:00", "2026-01-15T00:00:00+00:00"],
      ["2026-01-15T00:01:00+00:00", "2026-01-15T00:00:00+00:00"],
    ]
  );
});

// Checks the value carried in at the period start is marked, with no claimed change time,
// while the next settings-only step still shows when the value really changed.
test("buildJsonPayload: the start-of-period row has no last_changed and is marked start_of_period", () => {
  const records = recordsFrom([
    { s: "on", lu: BASE, a: { brightness: 26 } },
    { s: "on", lu: BASE + 30, lc: BASE - 86400, a: { brightness: 51 } },
  ]);
  const payload = buildJsonPayload({ ...JSON_META, periodStartMs: BASE * 1000 }, records, "UTC");
  assert.equal(payload.records[0].last_changed, null);
  assert.deepEqual(payload.records[0].derived, {
    state_changed: null,
    start_of_period: true,
    seconds_since_previous: null,
    brightness_percent: 10.2,
  });
  assert.equal(payload.records[1].last_changed, "2026-01-14T00:00:00+00:00");
  assert.deepEqual(payload.records[1].derived, { state_changed: false, seconds_since_previous: 30, brightness_percent: 20 });
});

// Checks a first row recorded after the period start is an ordinary change.
test("buildJsonPayload: a first row after the period start is not marked start_of_period", () => {
  const records = recordsFrom([{ s: "on", lu: BASE + 1, a: {} }]);
  const payload = buildJsonPayload({ ...JSON_META, periodStartMs: BASE * 1000 }, records, "UTC");
  assert.equal(payload.records[0].last_changed, "2026-01-15T00:00:01+00:00");
  assert.deepEqual(payload.records[0].derived, { state_changed: true, seconds_since_previous: null });
});

// Checks a settings-only step recorded exactly at the period start keeps its lc and is not marked.
test("buildJsonPayload: a settings-only row at the period start is not marked start_of_period", () => {
  const records = recordsFrom([{ s: "on", lu: BASE, lc: BASE - 60, a: {} }]);
  const payload = buildJsonPayload({ ...JSON_META, periodStartMs: BASE * 1000 }, records, "UTC");
  assert.equal(payload.records[0].last_changed, "2026-01-14T23:59:00+00:00");
  assert.deepEqual(payload.records[0].derived, { state_changed: false, seconds_since_previous: null });
});

// Checks only the first row can be the start-of-period row.
test("buildJsonPayload: a later row at the period start time is not marked start_of_period", () => {
  const records = recordsFrom([
    { s: "off", lu: BASE - 10, a: {} },
    { s: "on", lu: BASE, a: {} },
  ]);
  const payload = buildJsonPayload({ ...JSON_META, periodStartMs: BASE * 1000 }, records, "UTC");
  assert.deepEqual(payload.records[1].derived, { state_changed: true, seconds_since_previous: 10 });
  assert.equal(payload.records[1].last_changed, "2026-01-15T00:00:00+00:00");
});

// Checks a record with no change time is treated as changed at its own timestamp in both fields.
test("buildJsonPayload: a record without lastChangedMs reports state_changed true and last_changed as its timestamp", () => {
  const records = [{ timestampMs: BASE * 1000, state: "on", attributes: {} }];
  const payload = buildJsonPayload(JSON_META, records, "UTC");
  assert.equal(payload.records[0].last_changed, "2026-01-15T00:00:00+00:00");
  assert.equal(payload.records[0].derived.state_changed, true);
});

// Checks toJson passes the new blocks through.
test("toJson: includes the entity block and derived values", () => {
  const parsed = JSON.parse(toJson(JSON_META, bedsideRecords(), "UTC"));
  assert.equal(parsed.entity.domain, "light");
  assert.equal(parsed.records[1].derived.state_changed, false);
});

// --- causes ---------------------------------------------------------------

const SCRIPT_CAUSE = {
  context_entity_id: "script.weekend_sunrise",
  context_name: "Weekend sunrise",
  context_event_type: "script_started",
  context_domain: "script",
};

/** One logbook entry for x.y, as Home Assistant sends it. */
function logbookEntry(extra = {}) {
  return { when: BASE, state: "on", entity_id: "x.y", ...extra };
}

// Checks only value-change entries for the entity with a numeric time are kept, with their cause fields.
test("parseLogbookEntries: keeps entries for the entity that have a state and a numeric time", () => {
  const result = [
    logbookEntry(SCRIPT_CAUSE),
    { when: BASE + 5, entity_id: "x.y", message: "custom message" },
    logbookEntry({ entity_id: "other.thing", when: BASE + 6 }),
    logbookEntry({ when: "soon" }),
    logbookEntry({ when: BASE + 7, state: "off", context_user_id: "abc123" }),
    null,
  ];
  assert.deepEqual(parseLogbookEntries(result, "x.y"), [
    { whenMs: BASE * 1000, state: "on", cause: SCRIPT_CAUSE },
    { whenMs: (BASE + 7) * 1000, state: "off", cause: { context_user_id: "abc123" } },
  ]);
});

// Checks a result that is not a list gives no entries.
test("parseLogbookEntries: a missing or non-list result gives no entries", () => {
  assert.deepEqual(parseLogbookEntries(undefined, "x.y"), []);
  assert.deepEqual(parseLogbookEntries({ when: BASE }, "x.y"), []);
});

// Checks an entry with no cause fields still parses, with an empty cause.
test("parseLogbookEntries: an entry with no cause fields has an empty cause", () => {
  assert.deepEqual(parseLogbookEntries([logbookEntry()], "x.y"), [
    { whenMs: BASE * 1000, state: "on", cause: {} },
  ]);
});

// Checks the value-change row gets the cause while the settings-only rows get none.
test("attachCauses: an on row matches a logbook entry by time and a settings-only row never gets a cause", () => {
  const records = bedsideRecords();
  const entries = parseLogbookEntries([logbookEntry(SCRIPT_CAUSE)], "x.y");
  const result = attachCauses(records, entries);
  assert.deepEqual(result[0].cause, SCRIPT_CAUSE);
  assert.equal("cause" in result[1], false);
  assert.equal("cause" in result[2], false);
  assert.equal(result[0].state, "on");
  assert.deepEqual(result[0].attributes, records[0].attributes);
});

// Checks attachCauses returns new objects and leaves its input untouched.
test("attachCauses: returns new record objects without changing the input", () => {
  const records = bedsideRecords();
  const result = attachCauses(records, parseLogbookEntries([logbookEntry(SCRIPT_CAUSE)], "x.y"));
  assert.notEqual(result[0], records[0]);
  assert.equal("cause" in records[0], false);
});

// Checks the one millisecond tolerance edge, and that five milliseconds is too far.
test("attachCauses: matches within 1 ms and not 5 ms away", () => {
  const near = attachCauses(bedsideRecords(), parseLogbookEntries([logbookEntry({ ...SCRIPT_CAUSE, when: BASE + 0.001 })], "x.y"));
  assert.deepEqual(near[0].cause, SCRIPT_CAUSE);
  const far = attachCauses(bedsideRecords(), parseLogbookEntries([logbookEntry({ ...SCRIPT_CAUSE, when: BASE + 0.005 })], "x.y"));
  assert.equal("cause" in far[0], false);
});

// Checks an entry whose value differs from the row at that time does not match.
test("attachCauses: a different value at the same time does not match", () => {
  const result = attachCauses(bedsideRecords(), parseLogbookEntries([logbookEntry({ ...SCRIPT_CAUSE, state: "off" })], "x.y"));
  assert.equal("cause" in result[0], false);
});

// Checks one entry is given to the nearer of two close rows, not both.
test("attachCauses: the nearest row wins and the farther one gets no cause", () => {
  const records = recordsFrom([
    { s: "on", lu: BASE },
    { s: "on", lu: BASE + 0.0004, a: { brightness: 5 } },
  ]);
  const result = attachCauses(records, parseLogbookEntries([logbookEntry({ ...SCRIPT_CAUSE, when: BASE + 0.0003 })], "x.y"));
  assert.equal("cause" in result[0], false);
  assert.deepEqual(result[1].cause, SCRIPT_CAUSE);
});

// Checks a record that already has a cause keeps it when a second entry matches the same moment.
test("attachCauses: a record takes only the first entry that matches it", () => {
  const entries = parseLogbookEntries(
    [logbookEntry(SCRIPT_CAUSE), logbookEntry({ context_domain: "light", context_service: "turn_on" })],
    "x.y"
  );
  const result = attachCauses(bedsideRecords(), entries);
  assert.deepEqual(result[0].cause, SCRIPT_CAUSE);
});

// Checks an entry equally far from two rows goes to the earlier one.
test("attachCauses: a tie between two rows goes to the earlier row", () => {
  const records = recordsFrom([
    { s: "on", lu: BASE },
    { s: "on", lu: BASE + 0.002, a: { brightness: 5 } },
  ]);
  const result = attachCauses(records, parseLogbookEntries([logbookEntry({ ...SCRIPT_CAUSE, when: BASE + 0.001 })], "x.y"));
  assert.deepEqual(result[0].cause, SCRIPT_CAUSE);
  assert.equal("cause" in result[1], false);
});

// Checks entries given out of order are still matched, in time order.
test("attachCauses: entries given newest-first still match their rows", () => {
  const records = recordsFrom([
    { s: "on", lu: BASE },
    { s: "off", lu: BASE + 10 },
  ]);
  const entries = parseLogbookEntries(
    [
      logbookEntry({ when: BASE + 10, state: "off", context_domain: "light", context_service: "turn_off" }),
      logbookEntry(SCRIPT_CAUSE),
    ],
    "x.y"
  );
  const result = attachCauses(records, entries);
  assert.deepEqual(result[0].cause, SCRIPT_CAUSE);
  assert.deepEqual(result[1].cause, { context_domain: "light", context_service: "turn_off" });
});

// Checks competing entries are handled in time order, so the earlier moment wins a shared row.
test("attachCauses: of two entries for one row the earlier moment wins whatever the input order", () => {
  const entries = parseLogbookEntries(
    [
      logbookEntry({ when: BASE + 0.0008, context_user_id: "later" }),
      logbookEntry({ when: BASE, context_user_id: "earlier" }),
    ],
    "x.y"
  );
  const result = attachCauses(recordsFrom([{ s: "on", lu: BASE }]), entries);
  assert.deepEqual(result[0].cause, { context_user_id: "earlier" });
});

// Checks 50,000 records and entries are matched exactly and quickly.
test("attachCauses: matches 50,000 records against 50,000 entries exactly and quickly", () => {
  const COUNT = 50000;
  const rows = [];
  const logbook = [];
  for (let i = 0; i < COUNT; i++) {
    rows.push({ s: i % 2 ? "off" : "on", lu: BASE + i });
    if (i % 2 === 0) logbook.push(logbookEntry({ when: BASE + i, state: "on", context_user_id: `user-${i}` }));
    else logbook.push(logbookEntry({ when: BASE + i + 0.005, state: "off", context_user_id: `late-${i}` }));
  }
  const records = recordsFrom(rows);
  const entries = parseLogbookEntries(logbook, "x.y");
  const started = performance.now();
  const result = attachCauses(records, entries);
  const elapsed = performance.now() - started;
  assert.equal(result.length, COUNT);
  assert.deepEqual(result[0].cause, { context_user_id: "user-0" });
  assert.deepEqual(result[24998].cause, { context_user_id: "user-24998" });
  assert.deepEqual(result[COUNT - 2].cause, { context_user_id: `user-${COUNT - 2}` });
  assert.equal("cause" in result[1], false);
  assert.equal("cause" in result[25001], false);
  assert.equal(result.filter((r) => "cause" in r).length, COUNT / 2);
  assert.ok(elapsed < 2000, `took ${elapsed}ms`);
});

// Checks an entry with no cause fields attaches nothing.
test("attachCauses: an entry with no cause fields leaves the record without a cause", () => {
  const result = attachCauses(bedsideRecords(), parseLogbookEntries([logbookEntry()], "x.y"));
  assert.equal("cause" in result[0], false);
});

// Checks a script-triggered cause reads as the script and its name.
test("describeCause: a script cause reads the script entity and its name", () => {
  assert.equal(describeCause(SCRIPT_CAUSE), "script.weekend_sunrise (Weekend sunrise)");
});

// Checks the entity alone is used when there is no name.
test("describeCause: an entity with no name reads just the entity", () => {
  assert.equal(describeCause({ context_entity_id: "automation.porch" }), "automation.porch");
});

// Checks a service-only cause reads as domain.service.
test("describeCause: a service-only cause reads the domain and service", () => {
  assert.equal(describeCause({ context_domain: "light", context_service: "turn_on" }), "light.turn_on");
});

// Checks the source and message are used when no entity or service is named.
test("describeCause: falls back to the source and message", () => {
  assert.equal(
    describeCause({ context_source: "state of sun.sun", context_message: "triggered by sun" }),
    "state of sun.sun: triggered by sun"
  );
  assert.equal(describeCause({ context_message: "triggered by sun" }), "triggered by sun");
});

// Checks a user-only cause reads as the user id.
test("describeCause: a user-only cause reads the user id", () => {
  assert.equal(describeCause({ context_user_id: "abc123" }), "user abc123");
});

// Checks the entity wins over the service, and a cause with nothing usable reads blank.
test("describeCause: the entity wins over the service and nothing usable is blank", () => {
  assert.equal(describeCause({ ...SCRIPT_CAUSE, context_service: "turn_on" }), "script.weekend_sunrise (Weekend sunrise)");
  assert.equal(describeCause({ context_event_type: "call_service" }), "");
  assert.equal(describeCause(undefined), "");
});

// Checks a user-only cause reads as the person's name when the id is known.
test("describeCause: a user-only cause reads the person's name when known", () => {
  assert.equal(describeCause({ context_user_id: "abc123" }, { abc123: "Sam" }), "Sam");
});

// Checks an unknown user id keeps the id text.
test("describeCause: a user-only cause keeps the id when the person is not in the names", () => {
  assert.equal(describeCause({ context_user_id: "abc123" }, { other: "Sam" }), "user abc123");
});

// Checks a script cause is not replaced by a name even when the user is known.
test("describeCause: the names are only used for a user-only cause", () => {
  assert.equal(
    describeCause({ ...SCRIPT_CAUSE, context_user_id: "abc123" }, { abc123: "Sam" }),
    "script.weekend_sunrise (Weekend sunrise)"
  );
});

// Checks person entries become an id to name map with the documented fallbacks.
test("userNamesFromStates: maps user ids to friendly names, falling back to the object id", () => {
  const states = {
    "person.sam": { attributes: { user_id: "u1", friendly_name: "Sam Smith" } },
    "person.alex": { attributes: { user_id: "u2" } },
    "person.guest": { attributes: { friendly_name: "Guest" } },
    "light.bedside": { attributes: { user_id: "u3", friendly_name: "Bedside" } },
  };
  assert.deepEqual(userNamesFromStates(states), { u1: "Sam Smith", u2: "alex" });
});

// Checks missing states give an empty map.
test("userNamesFromStates: returns an empty map when there are no states", () => {
  assert.deepEqual(userNamesFromStates(undefined), {});
});

// Checks the CSV shows the person's name for a user-only cause.
test("toCsv: split layout names the person behind a user-only cause", () => {
  const records = attachCauses(bedsideRecords(), parseLogbookEntries([logbookEntry({ context_user_id: "u1" })], "x.y"));
  const rows = toCsv(records, "UTC", { userNames: { u1: "Sam Smith" } }).split("\r\n");
  assert.equal(rows[1], "2026-01-15T00:00:00+00:00,on,,3,1.2,hs,27.5,63.2,255,150,100,0.5,0.4,Sam Smith,");
});

/** Bedside rows with the first row caused by the script. */
function causedBedsideRecords() {
  return attachCauses(bedsideRecords(), parseLogbookEntries([logbookEntry(SCRIPT_CAUSE)], "x.y"));
}

// Checks the split CSV adds changed_by before details with the cause on the matched row only.
test("toCsv: split layout adds a changed_by column before details when a row has a cause", () => {
  const rows = toCsv(causedBedsideRecords(), "UTC").split("\r\n");
  assert.equal(
    rows[0],
    "timestamp,value,seconds_since_previous,brightness,brightness_percent,color_mode,hue,saturation,red,green,blue,x,y,changed_by,details"
  );
  assert.equal(rows[1], "2026-01-15T00:00:00+00:00,on,,3,1.2,hs,27.5,63.2,255,150,100,0.5,0.4,script.weekend_sunrise (Weekend sunrise),");
  assert.equal(rows[2], "2026-01-15T00:00:30+00:00,on,30,20,7.8,hs,28,63.2,255,152,100,0.5,0.4,,");
  assert.equal(rows[3], "2026-01-15T00:01:00+00:00,on,30.25,255,100,hs,30,70,255,170,76,0.45,0.41,,");
});

// Checks no causes means no changed_by column.
test("toCsv: split layout has no changed_by column when no row has a cause", () => {
  assert.equal(toCsv(bedsideRecords(), "UTC").split("\r\n")[0].includes("changed_by"), false);
});

// Checks a cause with nothing to describe does not add the column.
test("toCsv: split layout has no changed_by column when no cause can be described", () => {
  const records = attachCauses(bedsideRecords(), parseLogbookEntries([logbookEntry({ context_event_type: "call_service" })], "x.y"));
  assert.deepEqual(records[0].cause, { context_event_type: "call_service" });
  assert.equal(toCsv(records, "UTC").split("\r\n")[0].includes("changed_by"), false);
});

// Checks the legacy layout never gets a changed_by column.
test("toCsv: legacy layout has no changed_by column even when a row has a cause", () => {
  const rows = toCsv(causedBedsideRecords(), "UTC", { splitColumns: false }).split("\r\n");
  assert.equal(rows[0], "timestamp,value,details");
  assert.equal(rows[1].startsWith("2026-01-15T00:00:00+00:00,on,"), true);
  assert.equal(rows[1].includes("script.weekend_sunrise"), false);
});

// Checks the JSON gains the raw cause on the matched record only.
test("buildJsonPayload: a matched record carries its raw cause and others carry none", () => {
  const payload = buildJsonPayload(JSON_META, causedBedsideRecords(), "UTC");
  assert.deepEqual(payload.records[0].cause, SCRIPT_CAUSE);
  assert.equal("cause" in payload.records[1], false);
  assert.equal("cause" in payload.records[2], false);
});

// --- multi-entity ---------------------------------------------------------

const M0 = 1768435200; // 2026-01-15T00:00:00Z

/** Three entities' compressed rows as one history response. */
function multiResponse() {
  return {
    "light.bedside": [
      { s: "off", lu: M0, a: { friendly_name: "Bedside", supported_color_modes: ["hs"], color_mode: null, brightness: null } },
      { s: "on", lu: M0 + 60, a: { friendly_name: "Bedside", supported_color_modes: ["hs"], color_mode: "hs", brightness: 26, hs_color: [30, 80] } },
      { s: "on", lu: M0 + 90, lc: M0 + 60, a: { friendly_name: "Bedside", supported_color_modes: ["hs"], color_mode: "hs", brightness: 51, hs_color: [30, 70] } },
    ],
    "light.hall": [
      { s: "on", lu: M0, a: { friendly_name: "Hall", supported_color_modes: ["color_temp"], color_mode: "color_temp", brightness: 255, color_temp_kelvin: 3000 } },
      { s: "on", lu: M0 + 60, lc: M0 - 3600, a: { friendly_name: "Hall", supported_color_modes: ["color_temp"], color_mode: "color_temp", brightness: 128, color_temp_kelvin: 3000 } },
    ],
    "climate.lounge": [
      { s: "heat", lu: M0 + 30, a: { friendly_name: "Lounge", hvac_modes: ["off", "heat"], current_temperature: -1.5, temperature: 21 } },
    ],
  };
}

const MULTI_IDS = ["light.bedside", "light.hall", "climate.lounge"];
const MULTI_NAMES = { "light.bedside": "Bedside", "light.hall": "Hall", "climate.lounge": "Lounge" };

/** The fixture as the groups the multi formatters take, in selection order. */
function multiGroups() {
  const response = multiResponse();
  return MULTI_IDS.map((entityId) => ({
    entityId,
    friendlyName: MULTI_NAMES[entityId],
    records: normaliseRecords(parseHistoryRecords(response, entityId)),
  }));
}

// --- toMultiCsv -----------------------------------------------------------

const MULTI_SPLIT_HEADER =
  "entity_id,name,timestamp,value,seconds_since_previous,brightness,brightness_percent,color_mode,color_temp_kelvin,hue,saturation,current_temperature,temperature,details";

/** Split CSV text into rows of cells, for fixtures with no quoted commas. */
function csvCells(csv) {
  return csv.split("\r\n").map((line) => line.split(","));
}

/** Build one group from [state, seconds, attributes] rows of a single entity. */
function groupFrom(entityId, friendlyName, rows) {
  const response = { [entityId]: rows.map(([s, seconds, a]) => ({ s, lu: M0 + seconds, a })) };
  return { entityId, friendlyName, records: normaliseRecords(parseHistoryRecords(response, entityId)) };
}

// Checks rows run in time order across entities.
test("toMultiCsv: rows are in time order across entities", () => {
  const rows = csvCells(toMultiCsv(multiGroups(), "UTC")).slice(1);
  assert.deepEqual(
    rows.map((r) => [r[0], r[2]]),
    [
      ["light.bedside", "2026-01-15T00:00:00+00:00"],
      ["light.hall", "2026-01-15T00:00:00+00:00"],
      ["climate.lounge", "2026-01-15T00:00:30+00:00"],
      ["light.bedside", "2026-01-15T00:01:00+00:00"],
      ["light.hall", "2026-01-15T00:01:00+00:00"],
      ["light.bedside", "2026-01-15T00:01:30+00:00"],
    ]
  );
});

// Checks rows at the same instant follow the selection order, not the id order.
test("toMultiCsv: rows at the same time follow the selection order", () => {
  const byId = Object.fromEntries(multiGroups().map((g) => [g.entityId, g]));
  const order = ["light.hall", "light.bedside", "climate.lounge"];
  const rows = csvCells(toMultiCsv(order.map((id) => byId[id]), "UTC")).slice(1);
  assert.deepEqual(
    rows.map((r) => r[0]),
    ["light.hall", "light.bedside", "climate.lounge", "light.hall", "light.bedside", "light.bedside"]
  );
});

// Checks the split header unions every entity's columns, light columns first.
test("toMultiCsv: split header unions the columns with light columns first", () => {
  assert.equal(toMultiCsv(multiGroups(), "UTC").split("\r\n")[0], MULTI_SPLIT_HEADER);
});

// Checks descriptive attributes stay out even though the names differ between entities.
test("toMultiCsv: metadata is decided per entity, not across all of them", () => {
  const header = toMultiCsv(multiGroups(), "UTC").split("\r\n")[0].split(",");
  assert.equal(header.includes("brightness"), true);
  for (const name of ["friendly_name", "supported_color_modes", "hvac_modes"]) {
    assert.equal(header.includes(name), false, name);
  }
});

// Checks each row is flattened with its own entity's columns and blanks elsewhere.
test("toMultiCsv: cells hold each entity's own settings and are blank for others", () => {
  const rows = csvCells(toMultiCsv(multiGroups(), "UTC")).slice(1);
  assert.deepEqual(rows[1], ["light.hall", "Hall", "2026-01-15T00:00:00+00:00", "on", "", "255", "100", "color_temp", "3000", "", "", "", "", ""]);
  assert.deepEqual(rows[2], ["climate.lounge", "Lounge", "2026-01-15T00:00:30+00:00", "heat", "", "", "", "", "", "", "", "-1.5", "21", ""]);
  assert.deepEqual(rows[3], ["light.bedside", "Bedside", "2026-01-15T00:01:00+00:00", "on", "60", "26", "10.2", "hs", "", "30", "80", "", "", ""]);
});

// Checks the gap is measured to the same entity's previous row.
test("toMultiCsv: seconds_since_previous is per entity", () => {
  const rows = csvCells(toMultiCsv(multiGroups(), "UTC")).slice(1);
  assert.deepEqual(
    rows.map((r) => [r[0], r[4]]),
    [
      ["light.bedside", ""],
      ["light.hall", ""],
      ["climate.lounge", ""],
      ["light.bedside", "60"],
      ["light.hall", "60"],
      ["light.bedside", "30"],
    ]
  );
});

// Checks the legacy layout is the fixed five columns with the raw attributes.
test("toMultiCsv: legacy layout is entity_id,name,timestamp,value,details", () => {
  const lines = toMultiCsv(multiGroups(), "UTC", { splitColumns: false }).split("\r\n");
  assert.equal(lines[0], "entity_id,name,timestamp,value,details");
  const prefix = "climate.lounge,Lounge,2026-01-15T00:00:30+00:00,heat,";
  assert.equal(lines[3].startsWith(prefix), true);
  const details = lines[3].slice(prefix.length);
  assert.deepEqual(JSON.parse(details.slice(1, -1).replace(/""/g, '"')), multiGroups()[2].records[0].attributes);
});

// Checks attributes named like the multi fixed columns get the attribute_ prefix.
test("toMultiCsv: name and entity_id attributes become attribute_ columns", () => {
  const group = groupFrom("sensor.a", "Kitchen", [
    ["on", 0, { name: "Probe", entity_id: "x.y", temperature: 20 }],
    ["on", 10, { name: "Probe", entity_id: "x.z", temperature: 20 }],
  ]);
  const rows = csvCells(toMultiCsv([group], "UTC"));
  assert.deepEqual(rows[0], ["entity_id", "name", "timestamp", "value", "seconds_since_previous", "attribute_entity_id", "attribute_name", "temperature", "details"]);
  assert.deepEqual(rows[1], ["sensor.a", "Kitchen", "2026-01-15T00:00:00+00:00", "on", "", "x.y", "Probe", "20", ""]);
});

// Checks a name attribute keeps its own column in single-device output.
test("toCsv: a name attribute is still a name column for one device", () => {
  const group = groupFrom("sensor.a", "Kitchen", [["on", 0, { name: "Probe" }]]);
  assert.equal(toCsv(group.records, "UTC").split("\r\n")[0], "timestamp,value,seconds_since_previous,name,details");
});

// Checks a spreadsheet formula in a friendly name is neutralised and a missing name is blank.
test("toMultiCsv: the name column is escaped and blank when unknown", () => {
  const groups = [
    groupFrom("sensor.a", "=cmd", [["on", 0, {}]]),
    groupFrom("sensor.b", undefined, [["on", 1, {}]]),
  ];
  const rows = csvCells(toMultiCsv(groups, "UTC")).slice(1);
  assert.equal(rows[0][1], "'=cmd");
  assert.equal(rows[1][1], "");
  const legacy = csvCells(toMultiCsv(groups, "UTC", { splitColumns: false })).slice(1);
  assert.equal(legacy[0][1], "'=cmd");
  assert.equal(legacy[1][1], "");
});

// Checks attributes that do not fit a cell are kept in the details column.
test("toMultiCsv: leftover attributes go in the details column", () => {
  const group = groupFrom("sensor.a", "A", [["on", 0, { nested: { a: 1 } }]]);
  const lines = toMultiCsv([group], "UTC").split("\r\n");
  assert.equal(lines[0], "entity_id,name,timestamp,value,seconds_since_previous,details");
  assert.equal(lines[1], 'sensor.a,A,2026-01-15T00:00:00+00:00,on,,"{""nested"":{""a"":1}}"');
});

// Checks changed_by appears when only one entity has a cause, and only on that row.
test("toMultiCsv: changed_by appears when one entity has a cause", () => {
  const groups = multiGroups();
  groups[1].records[1].cause = { context_domain: "script", context_service: "sunrise" };
  const rows = csvCells(toMultiCsv(groups, "UTC"));
  assert.deepEqual(rows[0].slice(-2), ["changed_by", "details"]);
  assert.deepEqual(rows.slice(1).map((r) => r[r.length - 2]), ["", "", "", "", "script.sunrise", ""]);
});

// Checks user names reach the changed_by text.
test("toMultiCsv: changed_by uses the user names passed in", () => {
  const groups = multiGroups();
  groups[2].records[0].cause = { context_user_id: "u1" };
  const rows = csvCells(toMultiCsv(groups, "UTC", { userNames: { u1: "Sam" } }));
  assert.equal(rows[3][rows[3].length - 2], "Sam");
});

// Checks the legacy layout never gets a changed_by column.
test("toMultiCsv: legacy layout has no changed_by column", () => {
  const groups = multiGroups();
  groups[1].records[1].cause = { context_domain: "script", context_service: "sunrise" };
  const csv = toMultiCsv(groups, "UTC", { splitColumns: false });
  assert.equal(csv.includes("light.hall"), true);
  assert.equal(csv.includes("script.sunrise"), false);
});

// Checks Skip repeats applied per entity keeps rows another entity also repeats.
test("toMultiCsv: repeats are filtered per entity before the merge", () => {
  const a = groupFrom("sensor.a", "A", [["on", 0, {}], ["on", 60, {}], ["off", 120, {}]]);
  const b = groupFrom("sensor.b", "B", [["on", 0, {}], ["on", 60, {}], ["off", 100, {}]]);
  const groups = [a, b].map((g) => ({ ...g, records: filterRepeats(g.records) }));
  const rows = csvCells(toMultiCsv(groups, "UTC")).slice(1);
  assert.deepEqual(
    rows.map((r) => [r[0], r[3], r[4]]),
    [
      ["sensor.a", "on", ""],
      ["sensor.b", "on", ""],
      ["sensor.b", "off", "100"],
      ["sensor.a", "off", "120"],
    ]
  );
});

// --- buildMultiJsonPayload / toMultiJson / buildMultiFilename -------------

const MULTI_META = {
  exportedAtMs: (M0 + 7200) * 1000,
  periodStartMs: M0 * 1000,
  periodEndMs: (M0 + 3600) * 1000,
  stateChangesOnly: true,
};

// Checks the wrapper lists entities in selection order with shared period and totals.
test("buildMultiJsonPayload: wraps entities in selection order with shared period and totals", () => {
  const payload = buildMultiJsonPayload(MULTI_META, multiGroups(), "UTC");
  assert.deepEqual(Object.keys(payload), [
    "exported_at",
    "period",
    "state_changes_only",
    "entity_count",
    "record_count",
    "entities",
  ]);
  assert.equal(payload.exported_at, "2026-01-15T02:00:00+00:00");
  assert.deepEqual(payload.period, { start: "2026-01-15T00:00:00+00:00", end: "2026-01-15T01:00:00+00:00" });
  assert.equal(payload.state_changes_only, true);
  assert.equal(payload.entity_count, 3);
  assert.equal(payload.record_count, 6);
  assert.deepEqual(payload.entities.map((e) => e.entity_id), MULTI_IDS);
  assert.deepEqual(Object.keys(payload.entities[0]), ["entity_id", "friendly_name", "entity", "record_count", "records"]);
});

// Checks each entity block matches an independently built single-entity payload.
test("buildMultiJsonPayload: each entity block deep-equals buildJsonPayload for that entity minus the shared keys", () => {
  const groups = multiGroups();
  const payload = buildMultiJsonPayload(MULTI_META, groups, "UTC");
  groups.forEach((group, i) => {
    const expected = buildJsonPayload({ ...MULTI_META, entityId: group.entityId, friendlyName: group.friendlyName }, group.records, "UTC");
    delete expected.exported_at;
    delete expected.period;
    delete expected.state_changes_only;
    assert.deepEqual(payload.entities[i], expected);
  });
});

// Checks the start-of-period marker is decided per entity, not on the merged list.
test("buildMultiJsonPayload: start_of_period is marked per entity", () => {
  const payload = buildMultiJsonPayload(MULTI_META, multiGroups(), "UTC");
  const first = (id) => payload.entities.find((e) => e.entity_id === id).records[0];
  assert.equal(first("light.bedside").derived.start_of_period, true);
  assert.equal(first("light.hall").derived.start_of_period, true);
  assert.equal("start_of_period" in first("climate.lounge").derived, false);
  assert.equal(first("light.hall").last_changed, null);
  assert.equal(first("climate.lounge").last_changed, "2026-01-15T00:00:30+00:00");
});

// Checks an entity asked for with no rows is still listed.
test("buildMultiJsonPayload: an entity with no records is listed with record_count 0", () => {
  const groups = multiGroups();
  groups[1] = { ...groups[1], records: [] };
  const payload = buildMultiJsonPayload(MULTI_META, groups, "UTC");
  assert.equal(payload.entity_count, 3);
  assert.equal(payload.record_count, 4);
  assert.equal(payload.entities[1].entity_id, "light.hall");
  assert.equal(payload.entities[1].record_count, 0);
  assert.deepEqual(payload.entities[1].records, []);
});

// Checks toMultiJson prints the payload with two-space indentation.
test("toMultiJson: pretty-prints the payload with two spaces", () => {
  const groups = multiGroups();
  const text = toMultiJson(MULTI_META, groups, "UTC");
  assert.equal(text, JSON.stringify(buildMultiJsonPayload(MULTI_META, groups, "UTC"), null, 2));
  assert.equal(text.split("\n")[1], '  "exported_at": "2026-01-15T02:00:00+00:00",');
});

// Checks the multi filename carries the count and the date range.
test("buildMultiFilename: 3 items and the date range", () => {
  const start = Date.UTC(2026, 0, 15, 0, 0, 0);
  const end = Date.UTC(2026, 0, 16, 0, 0, 0);
  assert.equal(
    buildMultiFilename(3, start, end, "json", "UTC"),
    "activity-export_3-items_2026-01-15_2026-01-16.json"
  );
});

// --- buildCacheKey, buildExportGroups, describeMissingHistory -------------

// Checks the same devices in any order share one cache key.
test("buildCacheKey: selection order does not change the key", () => {
  assert.equal(
    buildCacheKey(["light.hall", "light.bedside", "climate.lounge"], 10, 20),
    buildCacheKey(["climate.lounge", "light.hall", "light.bedside"], 10, 20)
  );
  assert.equal(buildCacheKey(["b", "a"], 10, 20), "a,b|10|20");
});

// Checks a different device set or range gives a different cache key.
test("buildCacheKey: a different device set or range changes the key", () => {
  const base = buildCacheKey(["a", "b"], 10, 20);
  assert.notEqual(base, buildCacheKey(["a", "c"], 10, 20));
  assert.notEqual(base, buildCacheKey(["a"], 10, 20));
  assert.notEqual(base, buildCacheKey(["a", "b"], 11, 20));
  assert.notEqual(base, buildCacheKey(["a", "b"], 10, 21));
});

/** Build a records Map from {id: [[state, seconds], ...]} using plain records. */
function recordsMap(spec) {
  return new Map(
    Object.entries(spec).map(([id, rows]) => [
      id,
      rows.map(([state, seconds]) => ({
        timestampMs: (M0 + seconds) * 1000,
        lastChangedMs: (M0 + seconds) * 1000,
        state,
        attributes: {},
      })),
    ])
  );
}

// Checks groups follow the selection order and carry friendly names.
test("buildExportGroups: groups follow selection order with friendly names", () => {
  const map = recordsMap({ "light.a": [["on", 0]], "light.b": [["on", 1]] });
  const states = { "light.a": { attributes: { friendly_name: "Alpha" } }, "light.b": { attributes: {} } };
  const groups = buildExportGroups(["light.b", "light.a"], map, states, false);
  assert.deepEqual(
    groups.map((g) => [g.entityId, g.friendlyName, g.records.length]),
    [["light.b", null, 1], ["light.a", "Alpha", 1]]
  );
});

// Checks a selected device with no cached records becomes an empty group.
test("buildExportGroups: a device with no records gives an empty group", () => {
  const groups = buildExportGroups(["light.a", "light.gone"], recordsMap({ "light.a": [["on", 0]] }), {}, false);
  assert.equal(groups[1].entityId, "light.gone");
  assert.deepEqual(groups[1].records, []);
});

// Checks Skip repeats works on each device's own rows, so another device's rows never hide a change.
test("buildExportGroups: Skip repeats is applied to each device on its own", () => {
  const map = recordsMap({
    "light.a": [["on", 0], ["on", 2], ["off", 4]],
    "light.b": [["on", 1], ["off", 3], ["off", 5]],
  });
  const groups = buildExportGroups(["light.a", "light.b"], map, {}, true);
  assert.deepEqual(groups[0].records.map((r) => r.state), ["on", "off"]);
  assert.deepEqual(groups[1].records.map((r) => r.state), ["on", "off"]);
  const csv = toMultiCsv(groups, "UTC", { splitColumns: false });
  assert.equal(csv.split("\r\n").length, 1 + 4);
});

// Checks every row is kept when Skip repeats is off.
test("buildExportGroups: keeps every row when Skip repeats is off", () => {
  const map = recordsMap({ "light.a": [["on", 0], ["on", 2], ["off", 4]] });
  const groups = buildExportGroups(["light.a"], map, {}, false);
  assert.equal(groups[0].records.length, 3);
});

// Checks the missing history sentence for one, two and three devices.
test("describeMissingHistory: names the devices in plain language", () => {
  assert.equal(describeMissingHistory([]), "");
  assert.equal(describeMissingHistory(["Hall"]), "No history for Hall in this period.");
  assert.equal(describeMissingHistory(["Hall", "Garage"]), "No history for Hall and Garage in this period.");
  assert.equal(
    describeMissingHistory(["Hall", "Garage", "Lounge"]),
    "No history for Hall, Garage and Lounge in this period."
  );
});
