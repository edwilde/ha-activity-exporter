import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PRESET_DAYS,
  buildFilename,
  buildJsonPayload,
  chunkRangeByDay,
  computeRange,
  filterStateChanges,
  formatDateForFilename,
  formatTimestamp,
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

test("parseHistoryRecords: maps compressed keys, prefers lc over lu", () => {
  const result = {
    "binary_sensor.front_door": [
      { s: "on", a: { device_class: "door" }, lu: 1768435200, lc: 1768435100 },
      { s: "off", a: {}, lu: 1768435260 }, // no lc -> uses lu
    ],
  };
  const records = parseHistoryRecords(result, "binary_sensor.front_door");
  assert.equal(records.length, 2);
  assert.equal(records[0].state, "on");
  assert.equal(records[0].timestampMs, 1768435100 * 1000); // lc wins
  assert.deepEqual(records[0].attributes, { device_class: "door" });
  assert.equal(records[1].timestampMs, 1768435260 * 1000); // falls back to lu
  assert.deepEqual(records[1].attributes, {});
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

// --- filterStateChanges ---------------------------------------------------

test("filterStateChanges: keeps baseline and transitions only", () => {
  const input = [
    { timestampMs: 1, state: "on", attributes: {} },
    { timestampMs: 2, state: "on", attributes: { brightness: 10 } }, // attr-only -> dropped
    { timestampMs: 3, state: "off", attributes: {} },
    { timestampMs: 4, state: "off", attributes: {} }, // dropped
    { timestampMs: 5, state: "on", attributes: {} },
  ];
  const out = filterStateChanges(input);
  assert.deepEqual(
    out.map((r) => r.state),
    ["on", "off", "on"]
  );
});

test("filterStateChanges: empty input -> empty output", () => {
  assert.deepEqual(filterStateChanges([]), []);
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
