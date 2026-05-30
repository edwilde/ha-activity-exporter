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
  const DAY_MS = 24 * 60 * 60 * 1000;
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
 * @returns {{timestampMs: number, state: string, attributes: object}[]}
 */
export function parseHistoryRecords(wsResult, entityId) {
  const rows = (wsResult && wsResult[entityId]) || [];
  const records = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const lu = typeof row.lu === "number" ? row.lu : undefined;
    const lc = typeof row.lc === "number" ? row.lc : lu;
    const whenSec = lc !== undefined ? lc : lu;
    if (whenSec === undefined) continue;
    records.push({
      timestampMs: whenSec * 1000,
      state: row.s != null ? String(row.s) : "",
      attributes: row.a && typeof row.a === "object" ? row.a : {},
    });
  }
  return records;
}

/**
 * Sort records oldest-first and remove exact duplicates (same timestamp + state)
 * that can appear at day-chunk boundaries.
 *
 * @param {{timestampMs: number, state: string, attributes: object}[]} records
 */
export function normaliseRecords(records) {
  const sorted = [...records].sort((a, b) => a.timestampMs - b.timestampMs);
  const out = [];
  let prevKey;
  for (const r of sorted) {
    const key = `${r.timestampMs}|${r.state}`;
    if (key !== prevKey) {
      out.push(r);
      prevKey = key;
    }
  }
  return out;
}

/**
 * "Skip repeats" filter: keep a record only when its state VALUE differs from
 * the previously kept record. The first record is always kept as the baseline.
 *
 * @param {{state: string}[]} records assumed oldest-first
 */
export function filterStateChanges(records) {
  const out = [];
  let prevState;
  for (const r of records) {
    if (out.length === 0 || r.state !== prevState) {
      out.push(r);
      prevState = r.state;
    }
  }
  return out;
}

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

/** Escape a single CSV field per RFC-4180. */
function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build CSV text (CRLF line endings, RFC-4180 quoting).
 * Columns: timestamp, state, attributes (attributes as a compact JSON string).
 */
export function toCsv(records, timeZone) {
  const lines = ["timestamp,state,attributes"];
  for (const r of records) {
    lines.push(
      [
        csvEscape(formatTimestamp(r.timestampMs, timeZone)),
        csvEscape(r.state),
        csvEscape(JSON.stringify(r.attributes || {})),
      ].join(",")
    );
  }
  return lines.join("\r\n");
}

/**
 * Build the self-describing JSON payload object.
 *
 * @param {{entityId:string, friendlyName?:string, exportedAtMs:number,
 *          periodStartMs:number, periodEndMs:number, stateChangesOnly:boolean}} meta
 * @param {{timestampMs:number, state:string, attributes:object}[]} records
 * @param {string} [timeZone]
 */
export function buildJsonPayload(meta, records, timeZone) {
  return {
    entity_id: meta.entityId,
    friendly_name: meta.friendlyName ?? null,
    exported_at: formatTimestamp(meta.exportedAtMs, timeZone),
    period: {
      start: formatTimestamp(meta.periodStartMs, timeZone),
      end: formatTimestamp(meta.periodEndMs, timeZone),
    },
    state_changes_only: !!meta.stateChangesOnly,
    record_count: records.length,
    records: records.map((r) => ({
      timestamp: formatTimestamp(r.timestampMs, timeZone),
      state: r.state,
      attributes: r.attributes || {},
    })),
  };
}

/** Build pretty-printed JSON text. */
export function toJson(meta, records, timeZone) {
  return JSON.stringify(buildJsonPayload(meta, records, timeZone), null, 2);
}
