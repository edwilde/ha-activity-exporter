/**
 * Pure, browser-global-free logic for Activity Exporter.
 *
 * Everything here is a plain function with no dependency on `document`,
 * `window`, `customElements`, or `Blob`, so it can be unit-tested directly with
 * `node --test`. The web component (activity-exporter-panel.js) imports from
 * here and owns all the DOM/Blob work.
 *
 * Home Assistant's `history/history_during_period` WebSocket command returns the
 * *compressed* state format: an object keyed by entity_id, each value a list of
 * rows using short keys:
 *   s  -> state (string)
 *   a  -> attributes (object; omitted when no_attributes=true)
 *   lu -> last_updated (epoch SECONDS, float)
 *   lc -> last_changed (epoch SECONDS, float; present only when != lu)
 */

/** Days covered by each named preset. */
export const PRESET_DAYS = { "24h": 1, "7d": 7, "30d": 30 };

const DAY_MS = 24 * 60 * 60 * 1000;

// --- time zone helpers ----------------------------------------------------

/**
 * Return the wall-clock string and numeric UTC offset (minutes) of an instant
 * in a given IANA time zone. Internal helper shared by the formatters and the
 * wall-clock parser so the offset maths lives in exactly one place.
 */
function tzWallAndOffset(ms, timeZone) {
  const date = new Date(ms);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === "24" ? "00" : map.hour;
  const wall = `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}:${map.second}`;
  // Offset = (wall clock interpreted as UTC) - (actual UTC instant).
  const offsetMin = Math.round((Date.parse(`${wall}Z`) - date.getTime()) / 60000);
  return { wall, offsetMin };
}

/**
 * Convert a wall-clock string ("YYYY-MM-DDTHH:mm", as produced by an
 * <input type="datetime-local">) into an epoch-ms instant, interpreting it in
 * the given IANA time zone rather than the browser's. Falls back to the
 * browser's zone (Date.parse) when no time zone is supplied.
 */
export function wallClockToEpochMs(wallClock, timeZone) {
  if (!wallClock) return NaN;
  if (!timeZone) return Date.parse(wallClock);
  const provisional = Date.parse(`${wallClock}Z`); // treat the wall time as UTC
  if (!Number.isFinite(provisional)) return NaN;
  // First guess using the offset at the provisional instant, then correct once
  // in case the guess landed on the other side of a DST transition.
  const firstOffset = tzWallAndOffset(provisional, timeZone).offsetMin;
  let epoch = provisional - firstOffset * 60000;
  const secondOffset = tzWallAndOffset(epoch, timeZone).offsetMin;
  if (secondOffset !== firstOffset) {
    epoch = provisional - secondOffset * 60000;
  }
  return epoch;
}

/**
 * Resolve the export window (epoch ms) for the chosen preset or custom range.
 * Custom wall-clock values are interpreted in `timeZone` so the queried window
 * matches the timestamps shown in the exported file.
 *
 * @returns {{startMs:number, endMs:number}} (values are NaN when not resolvable)
 */
export function computeRange(preset, customStart, customEnd, nowMs, timeZone) {
  if (preset === "custom") {
    return {
      startMs: wallClockToEpochMs(customStart, timeZone),
      endMs: wallClockToEpochMs(customEnd, timeZone),
    };
  }
  const days = PRESET_DAYS[preset];
  if (!days) return { startMs: NaN, endMs: NaN };
  return { startMs: nowMs - days * DAY_MS, endMs: nowMs };
}

// --- history fetching helpers ---------------------------------------------

/**
 * Split an ISO time range into <= 1-day chunks so history can be fetched
 * incrementally with real progress feedback.
 *
 * @param {string} startISO ISO-8601 start (inclusive)
 * @param {string} endISO   ISO-8601 end (exclusive)
 * @returns {{start: string, end: string}[]} ordered UTC-ISO chunk boundaries
 */
export function chunkRangeByDay(startISO, endISO) {
  const startMs = Date.parse(startISO);
  const endMs = Date.parse(endISO);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return [];
  }
  const chunks = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const next = Math.min(cursor + DAY_MS, endMs);
    chunks.push({
      start: new Date(cursor).toISOString(),
      end: new Date(next).toISOString(),
    });
    cursor = next;
  }
  return chunks;
}

/**
 * Convert one entity's compressed-state rows into normalised records.
 *
 * @param {Record<string, any[]>} wsResult result object from the WS command
 * @param {string} entityId entity whose rows to extract
 * @returns {{timestampMs: number, lastChangedMs: number, state: string, attributes: object}[]}
 */
export function parseHistoryRecords(wsResult, entityId) {
  const rows = (wsResult && wsResult[entityId]) || [];
  const records = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (typeof row.lu !== "number") continue;
    const lc = typeof row.lc === "number" ? row.lc : row.lu;
    records.push({
      timestampMs: row.lu * 1000,
      lastChangedMs: lc * 1000,
      state: row.s != null ? String(row.s) : "",
      attributes: row.a && typeof row.a === "object" ? row.a : {},
    });
  }
  return records;
}

/** Attributes a mirror row carries about itself, which are not the source's details. */
const MIRROR_KEYS = ["source_entity_id", "source_last_updated", "friendly_name"];

/** Tolerance in ms when comparing a mirror row's source_last_updated to a source row's time. */
const MIRROR_MATCH_MS = 1;

/**
 * Copy a mirror row's attributes without the keys the mirror adds about itself.
 *
 * @param {object} attributes a mirror record's attributes
 * @returns {object} the saved details only
 */
function stripMirrorKeys(attributes) {
  const details = { ...attributes };
  for (const key of MIRROR_KEYS) delete details[key];
  return details;
}

/**
 * Merge the details a mirror saved into the source's rows, carrying each saved
 * set forward until the next one; with no source rows, rebuild rows from the mirror.
 *
 * @param {{timestampMs: number, lastChangedMs: number, state: string, attributes: object}[]} sourceRecords
 * @param {{timestampMs: number, lastChangedMs: number, state: string, attributes: object}[]} mirrorRecords
 * @returns {{timestampMs: number, lastChangedMs: number, state: string, attributes: object}[]} new records, oldest first
 */
export function mergeMirrorRecords(sourceRecords, mirrorRecords) {
  const mirrors = mirrorRecords
    .filter((m) => typeof m.attributes.source_last_updated === "number")
    .sort((a, b) => a.attributes.source_last_updated - b.attributes.source_last_updated);
  if (sourceRecords.length === 0) {
    return mirrors.map((m) => ({
      ...m,
      timestampMs: m.attributes.source_last_updated * 1000,
      lastChangedMs: m.attributes.source_last_updated * 1000,
      attributes: stripMirrorKeys(m.attributes),
    }));
  }
  const sources = [...sourceRecords].sort((a, b) => a.timestampMs - b.timestampMs);
  let next = 0;
  let latest = null;
  return sources.map((source) => {
    while (
      next < mirrors.length &&
      mirrors[next].attributes.source_last_updated * 1000 <= source.timestampMs + MIRROR_MATCH_MS
    ) {
      latest = mirrors[next];
      next += 1;
    }
    if (!latest) return { ...source, attributes: { ...source.attributes } };
    return {
      ...source,
      attributes: { ...stripMirrorKeys(latest.attributes), ...source.attributes },
    };
  });
}

/**
 * Turn the backend's list of an entity's details into checkbox choices, ticking
 * those HA does not record unless they change very often.
 *
 * @param {{name: string, unrecorded: boolean, volatile: boolean}[]} details
 * @returns {{name: string, label: string, checked: boolean, note: string}[]}
 */
export function detailChoices(details) {
  return details.map(({ name, unrecorded, volatile }) => {
    const spaced = name.replace(/_/g, " ");
    return {
      name,
      label: spaced.charAt(0).toUpperCase() + spaced.slice(1),
      checked: unrecorded && !volatile,
      note: volatile ? "changes very often, uses more space" : "",
    };
  });
}

/**
 * Serialise a value to JSON text with object keys sorted at every depth, so two
 * values with the same content always give the same string.
 *
 * @param {any} value
 * @returns {string}
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Sort records oldest-first and remove exact duplicates (same timestamp, state
 * and attributes) that can appear at day-chunk boundaries.
 *
 * @param {{timestampMs: number, state: string, attributes: object}[]} records
 */
export function normaliseRecords(records) {
  const sorted = [...records].sort((a, b) => a.timestampMs - b.timestampMs);
  const out = [];
  let seenAtTimestamp = new Set();
  let currentTimestamp;
  for (const r of sorted) {
    if (r.timestampMs !== currentTimestamp) {
      currentTimestamp = r.timestampMs;
      seenAtTimestamp = new Set();
    }
    const key = `${r.state}|${stableStringify(r.attributes || {})}`;
    if (!seenAtTimestamp.has(key)) {
      out.push(r);
      seenAtTimestamp.add(key);
    }
  }
  return out;
}

/** Attributes that change continuously and do not count as a real change. */
const VOLATILE_ATTRIBUTES = new Set(["media_position", "media_position_updated_at"]);

/**
 * Serialise a record's value and attributes, leaving out the volatile
 * attributes, so equal strings mean "nothing meaningful changed".
 *
 * @param {{state: string, attributes: object}} record
 * @returns {string}
 */
function repeatSignature(record) {
  const attributes = {};
  for (const [key, value] of Object.entries(record.attributes || {})) {
    if (!VOLATILE_ATTRIBUTES.has(key)) attributes[key] = value;
  }
  return `${record.state}|${stableStringify(attributes)}`;
}

/**
 * Keep a record only when its value or attributes differ from the previously
 * kept record, ignoring the volatile attributes.
 *
 * @param {{state: string, attributes: object}[]} records assumed oldest-first
 */
export function filterRepeats(records) {
  const out = [];
  let prevSignature;
  for (const r of records) {
    const signature = repeatSignature(r);
    if (signature !== prevSignature) {
      out.push(r);
      prevSignature = signature;
    }
  }
  return out;
}

// --- settings columns -----------------------------------------------------

/** Attribute names that describe a device rather than record a setting. */
const METADATA_NAMES = new Set([
  "friendly_name",
  "icon",
  "entity_picture",
  "unit_of_measurement",
  "device_class",
  "state_class",
  "attribution",
  "supported_features",
  "supported_color_modes",
  "assumed_state",
  "editable",
  "id",
  "restored",
  "options",
  "entity_id",
  "step",
]);

/** Name patterns for descriptive attributes: min_*, max_*, *_list, *_modes, *_step. */
const METADATA_PATTERN = /^(min_|max_)|(_list|_modes|_step)$/;

/** Columns that always exist in the split CSV layout. */
const FIXED_COLUMNS = new Set([
  "timestamp",
  "value",
  "seconds_since_previous",
  "changed_by",
  "details",
]);

/** Light columns, in the order they appear before the other attribute columns. */
const LIGHT_COLUMNS = [
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
];

/**
 * How each light colour tuple maps onto named columns: the column for each
 * position, in order (the tuple length is the number of columns).
 */
const LIGHT_TUPLES = [
  ["hs_color", ["hue", "saturation"]],
  ["rgb_color", ["red", "green", "blue"]],
  ["rgbw_color", ["red", "green", "blue", "white"]],
  ["rgbww_color", ["red", "green", "blue", "cold_white", "warm_white"]],
  ["xy_color", ["x", "y"]],
];

/** The light colour tuple attribute names. */
const TUPLE_NAMES = new Set(LIGHT_TUPLES.map(([key]) => key));

/**
 * Report whether an attribute name looks like descriptive metadata.
 *
 * @param {string} name
 * @returns {boolean}
 */
function looksLikeMetadata(name) {
  return METADATA_NAMES.has(name) || METADATA_PATTERN.test(name);
}

/**
 * Find the attribute names to treat as metadata: names that look descriptive and
 * hold the same value in every record that has them.
 *
 * @param {{attributes: object}[]} records
 * @returns {Set<string>}
 */
export function metadataKeys(records) {
  const seen = new Map();
  const varying = new Set();
  for (const r of records) {
    for (const [key, value] of Object.entries(r.attributes || {})) {
      if (!looksLikeMetadata(key)) continue;
      const signature = stableStringify(value);
      if (!seen.has(key)) seen.set(key, signature);
      else if (seen.get(key) !== signature) varying.add(key);
    }
  }
  return new Set([...seen.keys()].filter((key) => !varying.has(key)));
}

/**
 * Report whether a value is a string, number, boolean or null.
 *
 * @param {any} value
 * @returns {boolean}
 */
function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/**
 * Give a column name the attribute_ prefix when it matches a fixed column.
 *
 * @param {string} name
 * @param {Set<string>} [fixed] the fixed column names to avoid
 * @returns {string}
 */
function columnName(name, fixed = FIXED_COLUMNS) {
  return fixed.has(name) ? `attribute_${name}` : name;
}

/**
 * Convert a brightness (0-255) to a percentage with one decimal place.
 *
 * @param {any} brightness
 * @returns {number|null} null unless brightness is a finite number
 */
function brightnessPercent(brightness) {
  if (typeof brightness !== "number" || !Number.isFinite(brightness)) return null;
  return Math.round((brightness / 255) * 1000) / 10;
}

/**
 * Split an attributes object into spreadsheet cells and the leftovers that do
 * not fit in a cell.
 *
 * @param {object} attributes
 * @param {Set<string>} metadata keys from metadataKeys()
 * @param {Set<string>} [fixed] the fixed column names an attribute must not reuse
 * @returns {{cells: Record<string, any>, leftovers: Record<string, any>}}
 */
export function flattenAttributes(attributes, metadata, fixed = FIXED_COLUMNS) {
  const cells = {};
  const leftovers = {};
  for (const [key, value] of Object.entries(attributes || {})) {
    if (metadata.has(key) || value == null || TUPLE_NAMES.has(key)) continue;
    const column = columnName(key, fixed);
    if (column in cells) leftovers[key] = value;
    else if (isScalar(value)) cells[column] = value;
    else if (Array.isArray(value) && value.every(isScalar)) cells[column] = JSON.stringify(value);
    else leftovers[key] = value;
  }
  for (const [key, names] of LIGHT_TUPLES) {
    const value = attributes && attributes[key];
    if (metadata.has(key) || value == null) continue;
    const valid =
      Array.isArray(value) &&
      value.length === names.length &&
      value.every((n) => typeof n === "number" && Number.isFinite(n));
    if (!valid) {
      leftovers[key] = value;
      continue;
    }
    let placedAll = true;
    names.forEach((name, i) => {
      if (name in cells) placedAll = false;
      else cells[name] = value[i];
    });
    if (!placedAll) leftovers[key] = value;
  }
  const percent = brightnessPercent(cells.brightness);
  if (percent !== null && !("brightness_percent" in cells)) cells.brightness_percent = percent;
  return { cells, leftovers };
}

/**
 * Order setting column names with light columns first and the rest alphabetically.
 *
 * @param {Iterable<string>} names
 * @returns {string[]}
 */
function orderColumns(names) {
  const present = new Set(names);
  const light = LIGHT_COLUMNS.filter((name) => present.has(name));
  const rest = [...present].filter((name) => !LIGHT_COLUMNS.includes(name)).sort();
  return [...light, ...rest];
}

/**
 * List the attribute columns that hold a value in at least one record, light
 * columns first and the rest alphabetically.
 *
 * @param {{attributes: object}[]} records
 * @param {Set<string>} metadata keys from metadataKeys()
 * @param {Set<string>} [fixed] the fixed column names an attribute must not reuse
 * @returns {string[]}
 */
export function buildColumns(records, metadata, fixed = FIXED_COLUMNS) {
  const present = new Set();
  for (const r of records) {
    const { cells } = flattenAttributes(r.attributes, metadata, fixed);
    for (const [name, value] of Object.entries(cells)) {
      if (value !== "") present.add(name);
    }
  }
  return orderColumns(present);
}

// --- causes ---------------------------------------------------------------

/** How far apart (ms) a logbook entry and a history row may be and still match. */
const CAUSE_MATCH_MS = 1;

/** Logbook fields that say what caused a change. */
const CAUSE_FIELDS = [
  "context_user_id",
  "context_event_type",
  "context_domain",
  "context_service",
  "context_entity_id",
  "context_state",
  "context_name",
  "context_message",
  "context_source",
];

/**
 * Convert logbook entries for one entity into value-change entries with their
 * cause fields, leaving out entries with no value or no numeric time.
 *
 * @param {any[]} result result list from the logbook/get_events WS command
 * @param {string} entityId entity whose entries to extract
 * @returns {{whenMs: number, state: string, cause: Record<string, any>}[]}
 */
export function parseLogbookEntries(result, entityId) {
  if (!Array.isArray(result)) return [];
  const entries = [];
  for (const entry of result) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.entity_id !== entityId) continue;
    if (typeof entry.when !== "number" || entry.state == null) continue;
    const cause = {};
    for (const field of CAUSE_FIELDS) {
      if (entry[field] != null && entry[field] !== "") cause[field] = entry[field];
    }
    entries.push({ whenMs: entry.when * 1000, state: String(entry.state), cause });
  }
  return entries;
}

/**
 * Find the index of the first record whose timestamp is at least `ms`.
 *
 * @param {{timestampMs: number}[]} records oldest-first
 * @param {number} ms
 * @returns {number} records.length when every record is earlier
 */
function firstRecordFrom(records, ms) {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (records[mid].timestampMs < ms) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Give each record the cause of the nearest logbook entry with the same value at the same moment.
 *
 * @param {{timestampMs: number, state: string}[]} records oldest-first
 * @param {{whenMs: number, state: string, cause: Record<string, any>}[]} entries
 * @returns {object[]} new record objects, with `cause` set on the matched ones
 */
export function attachCauses(records, entries) {
  const out = records.map((r) => ({ ...r }));
  const taken = new Set();
  const margin = CAUSE_MATCH_MS + 0.001;
  const ordered = [...entries].sort((a, b) => a.whenMs - b.whenMs);
  for (const entry of ordered) {
    if (!Object.keys(entry.cause).length) continue;
    let best = -1;
    let bestGap = Infinity;
    for (let index = firstRecordFrom(out, entry.whenMs - margin); index < out.length; index++) {
      const r = out[index];
      if (r.timestampMs > entry.whenMs + margin) break;
      if (taken.has(index) || r.state !== entry.state) continue;
      const gap = Math.round(Math.abs(r.timestampMs - entry.whenMs) * 1000) / 1000;
      if (gap <= CAUSE_MATCH_MS && gap < bestGap) {
        best = index;
        bestGap = gap;
      }
    }
    if (best !== -1) {
      out[best].cause = entry.cause;
      taken.add(best);
    }
  }
  return out;
}

/**
 * Build a map of user id to display name from the person entries in a states object.
 *
 * @param {Record<string, {attributes?: Record<string, any>}>} [states]
 * @returns {Record<string, string>}
 */
export function userNamesFromStates(states) {
  const names = {};
  for (const [entityId, state] of Object.entries(states || {})) {
    if (!entityId.startsWith("person.")) continue;
    const userId = state?.attributes?.user_id;
    if (!userId) continue;
    names[userId] = state.attributes.friendly_name || entityId.slice("person.".length);
  }
  return names;
}

/**
 * Turn a cause into short text: the entity that did it, else the service that
 * was called, else the source or message, else the user.
 *
 * @param {Record<string, any>} [cause]
 * @param {Record<string, string>} [userNames] user id to display name
 * @returns {string} empty when nothing applies
 */
export function describeCause(cause, userNames) {
  const c = cause || {};
  if (c.context_entity_id) {
    return c.context_name ? `${c.context_entity_id} (${c.context_name})` : String(c.context_entity_id);
  }
  if (c.context_domain && c.context_service) return `${c.context_domain}.${c.context_service}`;
  const text = [c.context_source, c.context_message].filter(Boolean).join(": ");
  if (text) return text;
  if (!c.context_user_id) return "";
  return userNames?.[c.context_user_id] || `user ${c.context_user_id}`;
}

// --- formatting -----------------------------------------------------------

/**
 * Format an epoch-ms instant as ISO-8601 with the numeric offset of the given
 * IANA time zone (e.g. "2026-05-30T08:01:12+12:00"). Falls back to UTC ("...Z")
 * when no time zone is supplied.
 *
 * @param {number} ms epoch milliseconds
 * @param {string} [timeZone] IANA time zone (hass.config.time_zone)
 */
export function formatTimestamp(ms, timeZone) {
  const date = new Date(ms);
  if (!timeZone) return date.toISOString();
  const { wall, offsetMin } = tzWallAndOffset(ms, timeZone);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${wall}${sign}${oh}:${om}`;
}

/** YYYY-MM-DD in the given time zone, for filenames. */
export function formatDateForFilename(ms, timeZone) {
  return formatTimestamp(ms, timeZone).slice(0, 10);
}

/** Make a string safe to use as a download filename. */
export function sanitizeFilename(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Build the download filename: {entity}_{startDate}_{endDate}.{ext} */
export function buildFilename(entityId, startMs, endMs, ext, timeZone) {
  const base = `${sanitizeFilename(entityId)}_${formatDateForFilename(
    startMs,
    timeZone
  )}_${formatDateForFilename(endMs, timeZone)}`;
  return `${base}.${ext}`;
}

/** Build the multi-device download filename: activity-export_{N}-items_{startDate}_{endDate}.{ext} */
export function buildMultiFilename(count, startMs, endMs, ext, timeZone) {
  const base = `activity-export_${count}-items_${formatDateForFilename(
    startMs,
    timeZone
  )}_${formatDateForFilename(endMs, timeZone)}`;
  return `${base}.${ext}`;
}

/** Build the cache key for a fetch: the sorted ids, then the range, so selection order does not matter. */
export function buildCacheKey(entityIds, startMs, endMs) {
  return `${[...entityIds].sort().join(",")}|${startMs}|${endMs}`;
}

/**
 * Build one group per selected device, in selection order, with Skip repeats
 * applied to each device's own records.
 *
 * @param {string[]} entityIds in selection order
 * @param {Map<string, object[]>} recordsById normalised records per device
 * @param {Record<string, {attributes?: Record<string, any>}>} [states] used for friendly names
 * @param {boolean} [skipRepeats]
 * @returns {{entityId: string, friendlyName: string|null, records: object[]}[]}
 */
export function buildExportGroups(entityIds, recordsById, states, skipRepeats = false) {
  return entityIds.map((entityId) => {
    const records = recordsById.get(entityId) || [];
    return {
      entityId,
      friendlyName: states?.[entityId]?.attributes?.friendly_name || null,
      records: skipRepeats ? filterRepeats(records) : records,
    };
  });
}

/**
 * Say which devices have no history in the period, in plain language.
 *
 * @param {string[]} names display names of the devices with no rows
 * @returns {string} empty when every device has rows
 */
export function describeMissingHistory(names) {
  if (!names.length) return "";
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `No history for ${list} in this period.`;
}

/** Matches text that is a plain number, so a spreadsheet keeps it numeric. */
const NUMERIC_TEXT = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/**
 * Escape a single CSV field per RFC-4180, and neutralise spreadsheet formula
 * injection: a non-numeric field whose first character is one of = + - @ (tab/CR)
 * is prefixed with a single quote so Excel/Sheets treat it as text, not a
 * formula. Numbers (including negative ones) are left unprefixed.
 */
function csvEscape(value) {
  let s = value == null ? "" : String(value);
  const isNumber = typeof value === "number" ? Number.isFinite(value) : NUMERIC_TEXT.test(s);
  if (!isNumber && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Give the seconds between a record and the one before it, rounded to three
 * decimal places.
 *
 * @param {{timestampMs: number}[]} records oldest-first
 * @param {number} index position of the record to measure
 * @returns {number|null} null for the first record
 */
export function secondsSincePrevious(records, index) {
  if (index === 0) return null;
  return Math.round(records[index].timestampMs - records[index - 1].timestampMs) / 1000;
}

/** Fixed columns of the multi-device split layout. */
const MULTI_FIXED_COLUMNS = new Set([...FIXED_COLUMNS, "entity_id", "name"]);

/**
 * Build CSV text for one or more devices, with entity_id and name columns first
 * when `withEntity` is set and rows in time order across devices.
 *
 * @param {{entityId: string, friendlyName?: string, records: {timestampMs:number, state:string, attributes:object, cause?:object}[]}[]} groups
 * @param {string|undefined} timeZone
 * @param {{splitColumns?: boolean, userNames?: Record<string, string>}} options
 * @param {boolean} withEntity
 * @returns {string}
 */
function buildCsv(groups, timeZone, { splitColumns = true, userNames } = {}, withEntity) {
  const fixed = withEntity ? MULTI_FIXED_COLUMNS : FIXED_COLUMNS;
  const entityHeader = withEntity ? ["entity_id", "name"] : [];
  const entityCells = (group) => (withEntity ? [group.entityId, group.friendlyName] : []);
  const rows = groups.flatMap((group) =>
    group.records.map((record, index) => ({ group, record, index }))
  );
  if (withEntity) rows.sort((a, b) => a.record.timestampMs - b.record.timestampMs);
  if (!splitColumns) {
    const lines = [[...entityHeader, "timestamp", "value", "details"].join(",")];
    for (const { group, record } of rows) {
      lines.push(
        [
          ...entityCells(group),
          formatTimestamp(record.timestampMs, timeZone),
          record.state,
          JSON.stringify(record.attributes || {}),
        ]
          .map(csvEscape)
          .join(",")
      );
    }
    return lines.join("\r\n");
  }
  const metadata = new Map(groups.map((group) => [group, metadataKeys(group.records)]));
  const columns = orderColumns(
    groups.flatMap((group) => buildColumns(group.records, metadata.get(group), fixed))
  );
  const showCauses = rows.some(({ record }) => describeCause(record.cause, userNames) !== "");
  const lines = [
    [
      ...entityHeader,
      "timestamp",
      "value",
      "seconds_since_previous",
      ...columns,
      ...(showCauses ? ["changed_by"] : []),
      "details",
    ]
      .map(csvEscape)
      .join(","),
  ];
  for (const { group, record, index } of rows) {
    const { cells, leftovers } = flattenAttributes(record.attributes, metadata.get(group), fixed);
    const details = Object.keys(leftovers).length ? JSON.stringify(leftovers) : "";
    lines.push(
      [
        ...entityCells(group),
        formatTimestamp(record.timestampMs, timeZone),
        record.state,
        secondsSincePrevious(group.records, index),
        ...columns.map((name) => cells[name]),
        ...(showCauses ? [describeCause(record.cause, userNames)] : []),
        details,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\r\n");
}

/**
 * Build CSV text with CRLF line endings, one column per setting unless splitColumns is false.
 *
 * @param {{timestampMs:number, state:string, attributes:object, cause?:object}[]} records oldest-first
 * @param {string} [timeZone]
 * @param {{splitColumns?: boolean, userNames?: Record<string, string>}} [options]
 */
export function toCsv(records, timeZone, options) {
  return buildCsv([{ entityId: "", records }], timeZone, options, false);
}

/**
 * Build one CSV timeline for several devices, with entity_id and name columns,
 * rows in time order and ties in the order the groups are given.
 *
 * @param {{entityId: string, friendlyName?: string, records: {timestampMs:number, state:string, attributes:object, cause?:object}[]}[]} groups
 *   in selection order, each with oldest-first records already filtered as wanted
 * @param {string} [timeZone]
 * @param {{splitColumns?: boolean, userNames?: Record<string, string>}} [options]
 */
export function toMultiCsv(groups, timeZone, options) {
  return buildCsv(groups, timeZone, options, true);
}

/**
 * Give the part of an entity id before its first dot.
 *
 * @param {string} entityId
 * @returns {string}
 */
function entityDomain(entityId) {
  const dot = String(entityId).indexOf(".");
  return dot === -1 ? String(entityId) : String(entityId).slice(0, dot);
}

/**
 * Collect each metadata attribute with its value from the most recent record
 * that has it.
 *
 * @param {{attributes: object}[]} records oldest-first
 * @returns {Record<string, any>}
 */
function latestCapabilities(records) {
  const metadata = metadataKeys(records);
  const capabilities = {};
  for (const r of records) {
    for (const key of Object.keys(r.attributes || {})) {
      if (metadata.has(key)) capabilities[key] = r.attributes[key];
    }
  }
  return capabilities;
}

/**
 * Give the moment a record's value last changed, which is its own timestamp
 * when no separate change time is known.
 *
 * @param {{timestampMs:number, lastChangedMs?:number}} record
 * @returns {number}
 */
function changedAtMs(record) {
  return record.lastChangedMs ?? record.timestampMs;
}

/**
 * Whether a record is the value Home Assistant carried in at the period start
 * (stamped with the start time and no change time) rather than a recorded change.
 *
 * @param {{timestampMs:number, lastChangedMs?:number}[]} records oldest-first
 * @param {number} index position of the record
 * @param {number} periodStartMs
 * @returns {boolean}
 */
function isStartOfPeriod(records, index, periodStartMs) {
  const r = records[index];
  return (
    index === 0 &&
    Math.abs(r.timestampMs - periodStartMs) < 1 &&
    changedAtMs(r) === r.timestampMs
  );
}

/**
 * Compute the values derived for one record: whether its value changed, the
 * gap since the previous record, and brightness as a percentage when known.
 *
 * @param {{timestampMs:number, lastChangedMs?:number, attributes:object}[]} records oldest-first
 * @param {number} index position of the record
 * @param {boolean} startOfPeriod whether the record is the value at the period start
 * @returns {{state_changed: boolean|null, start_of_period?: true, seconds_since_previous: number|null, brightness_percent?: number}}
 */
function deriveValues(records, index, startOfPeriod) {
  const r = records[index];
  const derived = startOfPeriod
    ? { state_changed: null, start_of_period: true }
    : { state_changed: changedAtMs(r) === r.timestampMs };
  derived.seconds_since_previous = secondsSincePrevious(records, index);
  const percent = brightnessPercent((r.attributes || {}).brightness);
  if (percent !== null) derived.brightness_percent = percent;
  return derived;
}

/**
 * Build the self-describing JSON payload object. The keys here are a stable
 * machine schema (kept faithful to Home Assistant's own naming) so an LLM has
 * unambiguous context.
 *
 * @param {{entityId:string, friendlyName?:string, exportedAtMs:number,
 *          periodStartMs:number, periodEndMs:number, stateChangesOnly:boolean}} meta
 * @param {{timestampMs:number, lastChangedMs?:number, state:string, attributes:object}[]} records oldest-first
 * @param {string} [timeZone]
 */
export function buildJsonPayload(meta, records, timeZone) {
  const friendlyName = meta.friendlyName ?? null;
  return {
    entity_id: meta.entityId,
    friendly_name: friendlyName,
    entity: {
      entity_id: meta.entityId,
      friendly_name: friendlyName,
      domain: entityDomain(meta.entityId),
      capabilities: latestCapabilities(records),
    },
    exported_at: formatTimestamp(meta.exportedAtMs, timeZone),
    period: {
      start: formatTimestamp(meta.periodStartMs, timeZone),
      end: formatTimestamp(meta.periodEndMs, timeZone),
    },
    state_changes_only: !!meta.stateChangesOnly,
    record_count: records.length,
    records: records.map((r, index) => {
      const startOfPeriod = isStartOfPeriod(records, index, meta.periodStartMs);
      return {
        timestamp: formatTimestamp(r.timestampMs, timeZone),
        last_changed: startOfPeriod ? null : formatTimestamp(changedAtMs(r), timeZone),
        state: r.state,
        attributes: r.attributes || {},
        derived: deriveValues(records, index, startOfPeriod),
        ...(r.cause ? { cause: r.cause } : {}),
      };
    }),
  };
}

/** Build pretty-printed JSON text. */
export function toJson(meta, records, timeZone) {
  return JSON.stringify(buildJsonPayload(meta, records, timeZone), null, 2);
}

/**
 * Build the multi-device JSON payload: shared period and totals, then one block
 * per device in the order given, each built by buildJsonPayload.
 *
 * @param {{exportedAtMs:number, periodStartMs:number, periodEndMs:number,
 *          stateChangesOnly:boolean}} meta
 * @param {{entityId:string, friendlyName?:string, records:object[]}[]} groups
 * @param {string} [timeZone]
 */
export function buildMultiJsonPayload(meta, groups, timeZone) {
  const entities = groups.map((group) => {
    const {
      exported_at: _exportedAt,
      period: _period,
      state_changes_only: _stateChangesOnly,
      ...block
    } = buildJsonPayload(
      { ...meta, entityId: group.entityId, friendlyName: group.friendlyName },
      group.records,
      timeZone
    );
    return block;
  });
  return {
    exported_at: formatTimestamp(meta.exportedAtMs, timeZone),
    period: {
      start: formatTimestamp(meta.periodStartMs, timeZone),
      end: formatTimestamp(meta.periodEndMs, timeZone),
    },
    state_changes_only: !!meta.stateChangesOnly,
    entity_count: groups.length,
    record_count: groups.reduce((total, group) => total + group.records.length, 0),
    entities,
  };
}

/** Build pretty-printed multi-device JSON text. */
export function toMultiJson(meta, groups, timeZone) {
  return JSON.stringify(buildMultiJsonPayload(meta, groups, timeZone), null, 2);
}
