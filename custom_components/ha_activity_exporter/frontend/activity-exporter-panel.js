/**
 * Activity Exporter sidebar panel.
 *
 * A self-contained vanilla web component (no build step, no external/CDN
 * dependencies). It reads a single entity's history over the authenticated
 * Home Assistant WebSocket connection, builds a CSV or JSON file in the
 * browser, and downloads it. All formatting logic lives in exporter-core.js so
 * it can be unit-tested without a DOM.
 *
 * Audience note: this UI is for people who do NOT know Home Assistant
 * terminology. All visible copy avoids words like "entity", "state", and
 * "recorder". Keep it that way.
 */

import {
  buildFilename,
  chunkRangeByDay,
  filterStateChanges,
  normaliseRecords,
  parseHistoryRecords,
  toCsv,
  toJson,
} from "./exporter-core.js";

const PRESETS = {
  "24h": { label: "Last 24 hours", days: 1 },
  "7d": { label: "Last 7 days", days: 7 },
  "30d": { label: "Last 30 days", days: 30 },
};

// Above this many rows we show a gentle heads-up before the download.
const LARGE_RESULT_THRESHOLD = 25000;

const STYLES = `
  :host {
    display: block;
    padding: 16px;
    max-width: 720px;
    margin: 0 auto;
    color: var(--primary-text-color);
    font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
  }
  .card {
    background: var(--card-background-color, #fff);
    border-radius: var(--ha-card-border-radius, 12px);
    box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.12));
    padding: 24px;
  }
  h1 { font-size: 1.4rem; margin: 0 0 4px; font-weight: 500; }
  .intro { color: var(--secondary-text-color); margin: 0 0 24px; line-height: 1.5; }
  .field { margin-bottom: 24px; }
  .field > label.title {
    display: block;
    font-weight: 500;
    margin-bottom: 6px;
    font-size: 1.02rem;
  }
  .help { color: var(--secondary-text-color); font-size: 0.85rem; margin: 4px 0 10px; line-height: 1.4; }
  ha-entity-picker, .entity-fallback input { width: 100%; box-sizing: border-box; }
  .entity-fallback input {
    padding: 12px;
    border: 1px solid var(--divider-color, #ccc);
    border-radius: 8px;
    background: var(--secondary-background-color, #fafafa);
    color: var(--primary-text-color);
    font-size: 1rem;
  }
  .presets { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip {
    border: 1px solid var(--divider-color, #ccc);
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color);
    border-radius: 999px;
    padding: 8px 16px;
    cursor: pointer;
    font-size: 0.95rem;
    transition: background 0.15s, border-color 0.15s;
  }
  .chip:hover { border-color: var(--primary-color); }
  .chip[aria-pressed="true"] {
    background: var(--primary-color);
    color: var(--text-primary-color, #fff);
    border-color: var(--primary-color);
  }
  .custom-dates { margin-top: 14px; display: none; gap: 16px; flex-wrap: wrap; }
  .custom-dates.open { display: flex; }
  .custom-dates .date-field { flex: 1 1 200px; }
  .custom-dates label { display: block; font-size: 0.85rem; color: var(--secondary-text-color); margin-bottom: 4px; }
  .custom-dates input {
    width: 100%; box-sizing: border-box; padding: 10px;
    border: 1px solid var(--divider-color, #ccc); border-radius: 8px;
    background: var(--secondary-background-color, #fafafa);
    color: var(--primary-text-color); font-size: 0.95rem;
  }
  .toggle-row { display: flex; align-items: flex-start; gap: 12px; cursor: pointer; }
  .toggle-row input { margin-top: 3px; width: 18px; height: 18px; accent-color: var(--primary-color); flex: none; }
  .toggle-text .label { font-weight: 500; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
  button.export {
    flex: 1 1 220px;
    padding: 14px 18px;
    border: none;
    border-radius: 10px;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    background: var(--primary-color);
    color: var(--text-primary-color, #fff);
    transition: opacity 0.15s, filter 0.15s;
  }
  button.export.secondary {
    background: var(--secondary-background-color, #eee);
    color: var(--primary-text-color);
    border: 1px solid var(--divider-color, #ccc);
  }
  button.export:hover:not([disabled]) { filter: brightness(0.95); }
  button.export[disabled] { opacity: 0.5; cursor: not-allowed; }
  button.export .note { display: block; font-weight: 400; font-size: 0.78rem; opacity: 0.85; margin-top: 2px; }
  .progress { margin-top: 20px; display: none; }
  .progress.show { display: block; }
  .progress .track { height: 8px; background: var(--divider-color, #ddd); border-radius: 999px; overflow: hidden; }
  .progress .bar { height: 100%; width: 0%; background: var(--primary-color); transition: width 0.2s; }
  .progress .label { font-size: 0.85rem; color: var(--secondary-text-color); margin-top: 8px; }
  .status { margin-top: 20px; padding: 14px 16px; border-radius: 10px; font-size: 0.92rem; line-height: 1.45; display: none; }
  .status.show { display: block; }
  .status.error { background: rgba(var(--rgb-error-color, 219,68,55), 0.12); color: var(--error-color, #db4437); }
  .status.empty { background: var(--secondary-background-color, #f3f3f3); color: var(--secondary-text-color); }
  .status.success { background: rgba(var(--rgb-success-color, 67,160,71), 0.12); color: var(--success-color, #43a047); }
  .status.warn { background: rgba(var(--rgb-warning-color, 255,160,0), 0.14); color: var(--warning-color, #ffa000); }
  :host(.narrow) .card { padding: 16px; }
  :host(.narrow) button.export { flex-basis: 100%; }
`;

class ActivityExporterPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._narrow = false;
    this._built = false;

    // Form state.
    this._entityId = "";
    this._preset = "7d";
    this._customStart = "";
    this._customEnd = "";
    this._skipRepeats = false;

    // Cache of raw (unfiltered) records keyed by entity+range, so switching
    // format or toggling "skip repeats" never refetches.
    this._cacheKey = null;
    this._cacheRecords = null;

    this._busy = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._refreshEntityControl();
  }

  get hass() {
    return this._hass;
  }

  set narrow(value) {
    this._narrow = value;
    this.classList.toggle("narrow", !!value);
  }

  set panel(_panel) {
    /* unused */
  }

  set route(_route) {
    /* unused */
  }

  connectedCallback() {
    if (!this._built && this._hass) this._build();
  }

  // --- DOM construction (once) -------------------------------------------

  _build() {
    this._built = true;
    const root = this.shadowRoot;
    root.innerHTML = `
      <style>${STYLES}</style>
      <div class="card">
        <h1>Activity Exporter</h1>
        <p class="intro">Export the history of any device or sensor to a file you can open in a spreadsheet or hand to an AI for analysis.</p>

        <div class="field" id="entity-field">
          <label class="title" for="entity-control">What do you want to export?</label>
          <p class="help">Pick a device or sensor — like a light, thermostat, or door.</p>
          <div id="entity-control"></div>
        </div>

        <div class="field">
          <span class="title">Time period</span>
          <p class="help">Choose how far back to look.</p>
          <div class="presets" role="group" aria-label="Time period"></div>
          <div class="custom-dates" id="custom-dates">
            <div class="date-field">
              <label for="start-date">From</label>
              <input type="datetime-local" id="start-date" />
            </div>
            <div class="date-field">
              <label for="end-date">To</label>
              <input type="datetime-local" id="end-date" />
            </div>
          </div>
        </div>

        <div class="field">
          <label class="toggle-row">
            <input type="checkbox" id="skip-repeats" />
            <span class="toggle-text">
              <span class="label">Skip repeats — only show when something actually changed</span>
              <span class="help" style="margin:2px 0 0;">Keeps your file clean by leaving out rows where nothing changed.</span>
            </span>
          </label>
        </div>

        <div class="actions">
          <button class="export" id="export-csv" disabled>
            Download spreadsheet (CSV)
            <span class="note">Opens in Excel, Numbers, or Google Sheets</span>
          </button>
          <button class="export secondary" id="export-json" disabled>
            Download data file (JSON)
            <span class="note">Best for feeding to an AI</span>
          </button>
        </div>

        <div class="progress" id="progress" aria-live="polite">
          <div class="track"><div class="bar" id="progress-bar"></div></div>
          <div class="label" id="progress-label">Gathering history…</div>
        </div>

        <div class="status" id="status" role="status" aria-live="polite"></div>
      </div>
    `;

    this._els = {
      entityControl: root.getElementById("entity-control"),
      presets: root.querySelector(".presets"),
      customDates: root.getElementById("custom-dates"),
      startDate: root.getElementById("start-date"),
      endDate: root.getElementById("end-date"),
      skipRepeats: root.getElementById("skip-repeats"),
      csvBtn: root.getElementById("export-csv"),
      jsonBtn: root.getElementById("export-json"),
      progress: root.getElementById("progress"),
      progressBar: root.getElementById("progress-bar"),
      progressLabel: root.getElementById("progress-label"),
      status: root.getElementById("status"),
    };

    this._buildPresetChips();

    this._els.startDate.addEventListener("change", (e) => {
      this._customStart = e.target.value;
      this._invalidateCache();
      this._updateButtons();
    });
    this._els.endDate.addEventListener("change", (e) => {
      this._customEnd = e.target.value;
      this._invalidateCache();
      this._updateButtons();
    });
    this._els.skipRepeats.addEventListener("change", (e) => {
      this._skipRepeats = e.target.checked;
    });
    this._els.csvBtn.addEventListener("click", () => this._export("csv"));
    this._els.jsonBtn.addEventListener("click", () => this._export("json"));

    this._refreshEntityControl();
    this._updateButtons();
  }

  _buildPresetChips() {
    const group = this._els.presets;
    group.innerHTML = "";
    for (const [key, cfg] of Object.entries(PRESETS)) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.type = "button";
      chip.textContent = cfg.label;
      chip.dataset.preset = key;
      chip.setAttribute("aria-pressed", String(key === this._preset));
      chip.addEventListener("click", () => this._selectPreset(key));
      group.appendChild(chip);
    }
    const custom = document.createElement("button");
    custom.className = "chip";
    custom.type = "button";
    custom.textContent = "Choose your own dates";
    custom.dataset.preset = "custom";
    custom.setAttribute("aria-pressed", String(this._preset === "custom"));
    custom.addEventListener("click", () => this._selectPreset("custom"));
    group.appendChild(custom);
  }

  _selectPreset(key) {
    this._preset = key;
    for (const chip of this._els.presets.querySelectorAll(".chip")) {
      chip.setAttribute("aria-pressed", String(chip.dataset.preset === key));
    }
    this._els.customDates.classList.toggle("open", key === "custom");
    this._invalidateCache();
    this._updateButtons();
  }

  // --- Entity selection ---------------------------------------------------

  _refreshEntityControl() {
    if (!this._built || !this._hass) return;
    const host = this._els.entityControl;

    if (customElements.get("ha-entity-picker")) {
      let picker = host.querySelector("ha-entity-picker");
      if (!picker) {
        host.innerHTML = "";
        picker = document.createElement("ha-entity-picker");
        picker.id = "entity-control";
        picker.allowCustomEntity = false;
        picker.addEventListener("value-changed", (e) => {
          this._entityId = e.detail.value || "";
          this._invalidateCache();
          this._updateButtons();
        });
        host.appendChild(picker);
      }
      picker.hass = this._hass;
      return;
    }

    // Fallback: a searchable text input backed by a datalist. Used only when
    // ha-entity-picker is not available in the running Home Assistant build.
    if (!host.querySelector(".entity-fallback")) {
      host.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "entity-fallback";
      const input = document.createElement("input");
      input.type = "text";
      input.id = "entity-control";
      input.setAttribute("list", "entity-options");
      input.placeholder = "Start typing a name…";
      const list = document.createElement("datalist");
      list.id = "entity-options";
      input.addEventListener("change", () => {
        this._entityId = this._resolveFallbackValue(input.value);
        this._invalidateCache();
        this._updateButtons();
      });
      wrap.appendChild(input);
      wrap.appendChild(list);
      host.appendChild(wrap);
    }
    this._populateFallbackOptions();
  }

  _populateFallbackOptions() {
    const list = this._els.entityControl.querySelector("#entity-options");
    if (!list) return;
    const entries = Object.keys(this._hass.states || {}).sort();
    // Only rebuild when the count changes, to avoid clobbering on every tick.
    if (list.childElementCount === entries.length) return;
    list.innerHTML = "";
    for (const id of entries) {
      const friendly = this._hass.states[id]?.attributes?.friendly_name || id;
      const opt = document.createElement("option");
      opt.value = `${friendly} — ${id}`;
      list.appendChild(opt);
    }
  }

  _resolveFallbackValue(value) {
    const v = (value || "").trim();
    if (!v) return "";
    // Accept "Friendly — entity.id", a bare entity id, or a friendly name.
    const dashIdx = v.lastIndexOf(" — ");
    if (dashIdx !== -1) {
      const candidate = v.slice(dashIdx + 3).trim();
      if (this._hass.states[candidate]) return candidate;
    }
    if (this._hass.states[v]) return v;
    for (const [id, st] of Object.entries(this._hass.states || {})) {
      if ((st.attributes?.friendly_name || "") === v) return id;
    }
    return "";
  }

  // --- Time range ---------------------------------------------------------

  _computeRange() {
    if (this._preset === "custom") {
      const startMs = Date.parse(this._customStart);
      const endMs = Date.parse(this._customEnd);
      return { startMs, endMs };
    }
    const cfg = PRESETS[this._preset];
    const endMs = Date.now();
    const startMs = endMs - cfg.days * 24 * 60 * 60 * 1000;
    return { startMs, endMs };
  }

  _rangeValid() {
    const { startMs, endMs } = this._computeRange();
    return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
  }

  // --- Buttons / status ---------------------------------------------------

  _updateButtons() {
    const ready = !!this._entityId && this._rangeValid() && !this._busy;
    this._els.csvBtn.disabled = !ready;
    this._els.jsonBtn.disabled = !ready;

    if (this._preset === "custom" && this._entityId && !this._rangeValid()) {
      this._showStatus("warn", "Please choose a valid date range — the “To” date must be after the “From” date.");
    } else if (this._els.status.classList.contains("warn")) {
      this._hideStatus();
    }
  }

  _showStatus(kind, message) {
    const el = this._els.status;
    el.className = `status show ${kind}`;
    el.textContent = message;
  }

  _hideStatus() {
    this._els.status.className = "status";
    this._els.status.textContent = "";
  }

  _setProgress(percent, label) {
    this._els.progress.classList.add("show");
    this._els.progressBar.style.width = `${percent}%`;
    if (label) this._els.progressLabel.textContent = label;
  }

  _hideProgress() {
    this._els.progress.classList.remove("show");
    this._els.progressBar.style.width = "0%";
  }

  _invalidateCache() {
    this._cacheKey = null;
    this._cacheRecords = null;
  }

  // --- Export -------------------------------------------------------------

  async _export(format) {
    if (this._busy || !this._entityId || !this._rangeValid()) return;
    const { startMs, endMs } = this._computeRange();

    this._busy = true;
    this._updateButtons();
    this._hideStatus();

    let records;
    try {
      records = await this._loadRecords(startMs, endMs);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Activity Exporter: history request failed", err);
      this._hideProgress();
      this._busy = false;
      this._updateButtons();
      this._showStatus(
        "error",
        "Something went wrong while gathering the history. Please try again, or try a shorter time period."
      );
      return;
    }

    this._hideProgress();
    this._busy = false;
    this._updateButtons();

    if (!records.length) {
      this._showStatus(
        "empty",
        "No history found. Home Assistant may not be recording this item, or there was no activity in the period you chose."
      );
      return;
    }

    const finalRecords = this._skipRepeats ? filterStateChanges(records) : records;
    const timeZone = this._hass.config?.time_zone;
    const friendlyName = this._hass.states[this._entityId]?.attributes?.friendly_name || null;

    let content;
    let mime;
    let ext;
    if (format === "csv") {
      content = toCsv(finalRecords, timeZone);
      mime = "text/csv;charset=utf-8";
      ext = "csv";
    } else {
      content = toJson(
        {
          entityId: this._entityId,
          friendlyName,
          exportedAtMs: Date.now(),
          periodStartMs: startMs,
          periodEndMs: endMs,
          stateChangesOnly: this._skipRepeats,
        },
        finalRecords,
        timeZone
      );
      mime = "application/json;charset=utf-8";
      ext = "json";
    }

    const filename = buildFilename(this._entityId, startMs, endMs, ext, timeZone);
    this._downloadFile(filename, content, mime);

    const kind = finalRecords.length > LARGE_RESULT_THRESHOLD ? "warn" : "success";
    const big =
      kind === "warn"
        ? " That's a lot of rows — if your spreadsheet struggles, try a shorter period or turn on “Skip repeats”."
        : "";
    this._showStatus(
      kind,
      `Downloaded ${finalRecords.length.toLocaleString()} row${finalRecords.length === 1 ? "" : "s"} as ${filename}.${big}`
    );
  }

  async _loadRecords(startMs, endMs) {
    const key = `${this._entityId}|${startMs}|${endMs}`;
    if (this._cacheKey === key && this._cacheRecords) {
      return this._cacheRecords;
    }

    const startISO = new Date(startMs).toISOString();
    const endISO = new Date(endMs).toISOString();
    const chunks = chunkRangeByDay(startISO, endISO);

    this._setProgress(0, "Gathering history… 0%");
    let collected = [];
    for (let i = 0; i < chunks.length; i++) {
      const result = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: chunks[i].start,
        end_time: chunks[i].end,
        entity_ids: [this._entityId],
        // Only the first chunk seeds the starting value; later chunks must not
        // re-emit the carried-over value or we'd get duplicate boundary rows.
        include_start_time_state: i === 0,
        significant_changes_only: false,
        minimal_response: false,
        no_attributes: false,
      });
      collected = collected.concat(parseHistoryRecords(result, this._entityId));
      const percent = Math.round(((i + 1) / chunks.length) * 100);
      this._setProgress(percent, `Gathering history… ${percent}%`);
    }

    const records = normaliseRecords(collected);
    this._cacheKey = key;
    this._cacheRecords = records;
    return records;
  }

  _downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

if (!customElements.get("activity-exporter-panel")) {
  customElements.define("activity-exporter-panel", ActivityExporterPanel);
}
