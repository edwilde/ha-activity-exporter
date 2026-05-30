import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFilename,
  buildJsonPayload,
  chunkRangeByDay,
  filterStateChanges,
  formatDateForFilename,
  formatTimestamp,
  normaliseRecords,
  parseHistoryRecords,
  sanitizeFilename,
  toCsv,
  toJson,
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
  // contiguous: each chunk's end is the next chunk's start
  assert.equal(chunks[0].end, chunks[1].start);
  assert.equal(chunks[1].end, chunks[2].start);
  // last chunk ends exactly at the requested end
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

test("toCsv: header, CRLF rows, RFC-4180 escaping of attributes", () => {
  const records = [
    { timestampMs: Date.UTC(2026, 0, 15, 0, 0, 0), state: "on", attributes: { friendly_name: "Front, Door" } },
  ];
  const csv = toCsv(records, "UTC");
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "timestamp,state,attributes");
  // attributes column contains a comma + quotes -> whole field quoted, inner quotes doubled
  assert.ok(lines[1].startsWith("2026-01-15T00:00:00+00:00,on,"));
  assert.ok(lines[1].includes('"{""friendly_name"":""Front, Door""}"'));
});

test("toCsv: escapes commas/quotes/newlines in state", () => {
  const records = [
    { timestampMs: Date.UTC(2026, 0, 15, 0, 0, 0), state: 'a"b,c\nd', attributes: {} },
  ];
  const csv = toCsv(records, "UTC");
  const row = csv.split("\r\n")[1];
  assert.ok(row.includes('"a""b,c\nd"'));
});

// --- toJson / buildJsonPayload --------------------------------------------

test("buildJsonPayload: self-describing wrapper shape", () => {
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
