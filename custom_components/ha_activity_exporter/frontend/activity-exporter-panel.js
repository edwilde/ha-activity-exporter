/**
 * Activity Exporter sidebar panel.
 *
 * A self-contained vanilla web component (no build step, no external/CDN
 * dependencies). It reads the history of one or more devices over the
 * authenticated Home Assistant WebSocket connection, builds a CSV or JSON file
 * in the browser, and downloads it. All formatting logic lives in exporter-core.js so
 * it can be unit-tested without a DOM.
 *
 * Audience note: this UI is for people who do NOT know Home Assistant
 * terminology. All visible copy avoids words like "entity", "state", and
 * "recorder". Keep it that way.
 */

import {
  attachCauses,
  buildCacheKey,
  buildExportGroups,
  buildFilename,
  buildMultiFilename,
  chunkRangeByDay,
  computeRange,
  describeMissingHistory,
  detailChoices,
  withSavedDetails,
  mergeMirrorRecords,
  normaliseRecords,
  parseHistoryRecords,
  parseLogbookEntries,
  toCsv,
  toJson,
  toMultiCsv,
  toMultiJson,
  userNamesFromStates,
} from "./exporter-core.js";

// Chip labels; the actual day counts live in exporter-core.js (PRESET_DAYS).
const PRESETS = {
  "24h": { label: "Last 24 hours" },
  "7d": { label: "Last 7 days" },
  "30d": { label: "Last 30 days" },
};

// Above this many rows we show a gentle heads-up before the download.
const LARGE_RESULT_THRESHOLD = 25000;

// The most devices or sensors one download can hold.
const MAX_ENTITIES = 20;

// Added to a success message when the saved list could not be reloaded afterwards.
const STALE_LIST_NOTE = " The list below may be out of date - reopen this tab to refresh.";
const WS_DETAIL_LIST = "ha_activity_exporter/detail/list";
const WS_DETAIL_DESCRIBE = "ha_activity_exporter/detail/describe";
const WS_DETAIL_SAVE = "ha_activity_exporter/detail/save";

const ENTITY_HELP = "Pick one or more devices or sensors, like a light, thermostat or door.";
const ENTITY_HELP_FULL = `You can export up to ${MAX_ENTITIES} at once. Take one off the list to add another.`;

const STYLES = `
  :host {
    display: block;
    padding: 16px;
    max-width: 720px;
    margin: 0 auto;
    color: var(--primary-text-color);
    font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
    --ae-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
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
  fieldset.field { border: 0; padding: 0; margin: 0 0 24px; min-width: 0; }
  .title {
    display: block;
    font-weight: 500;
    margin-bottom: 6px;
    font-size: 1.02rem;
    padding: 0;
  }
  legend.title { margin-bottom: 2px; }
  .help { color: var(--secondary-text-color); font-size: 0.85rem; margin: 4px 0 10px; line-height: 1.4; }
  ha-entity-picker, .entity-fallback input { width: 100%; box-sizing: border-box; }
  .entity-fallback input {
    padding: 12px;
    border: 1px solid var(--divider-color, #ccc);
    border-radius: 8px;
    background: var(--secondary-background-color, #fafafa);
    color: var(--primary-text-color);
    font: inherit;
    font-size: 1rem;
  }
  .chosen-list { list-style: none; margin: 0 0 10px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .chosen-list[hidden], #entity-control[hidden] { display: none; }
  .chosen-row { display: flex; align-items: center; gap: 8px; }
  .chosen-row ha-entity-picker { flex: 1 1 auto; min-width: 0; width: auto; }
  .chosen-name {
    flex: 1 1 auto;
    min-width: 0;
    box-sizing: border-box;
    padding: 12px;
    border: 1px solid var(--divider-color, #ccc);
    border-radius: 8px;
    background: var(--secondary-background-color, #fafafa);
    overflow-wrap: anywhere;
  }
  button.remove {
    flex: none;
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid var(--divider-color, #ccc);
    border-radius: 8px;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color);
    font: inherit;
    font-size: 0.95rem;
    cursor: pointer;
  }
  button.remove:hover { border-color: var(--primary-color); }
  .presets { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip {
    border: 1px solid var(--divider-color, #ccc);
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color);
    border-radius: 999px;
    padding: 8px 16px;
    cursor: pointer;
    font: inherit;
    font-size: 0.95rem;
    transition: background-color 0.15s var(--ae-ease-out), border-color 0.15s var(--ae-ease-out), color 0.15s var(--ae-ease-out);
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
    color: var(--primary-text-color); font: inherit; font-size: 0.95rem;
  }
  .toggle-row { display: flex; align-items: flex-start; gap: 12px; cursor: pointer; }
  .toggle-row input { margin-top: 3px; width: 18px; height: 18px; accent-color: var(--primary-color); flex: none; }
  .toggle-text .label { display: block; font-weight: 500; }
  .toggle-text .toggle-help { display: block; margin: 2px 0 0; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
  button.export {
    flex: 1 1 220px;
    padding: 14px 18px;
    border: 1px solid transparent;
    border-radius: 10px;
    font: inherit;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    background: var(--primary-color);
    color: var(--text-primary-color, #fff);
    transition: filter 0.15s var(--ae-ease-out), background-color 0.15s var(--ae-ease-out);
  }
  button.export.secondary {
    background: var(--secondary-background-color, #eee);
    color: var(--primary-text-color);
    border: 1px solid var(--divider-color, #ccc);
  }
  button.export:hover:not([disabled]) { filter: brightness(0.95); }
  button.export[disabled],
  button.export.secondary[disabled] {
    background: var(--secondary-background-color, #eee);
    color: var(--secondary-text-color);
    border: 1px solid var(--divider-color, #ccc);
    opacity: 1;
    cursor: not-allowed;
  }
  button.export .note { display: block; font-weight: 400; font-size: 0.78rem; opacity: 0.85; margin-top: 2px; }
  .progress { margin-top: 20px; display: none; }
  .progress.show { display: block; }
  .progress .track { height: 8px; background: var(--divider-color, #ddd); border-radius: 999px; overflow: hidden; }
  .progress .bar { height: 100%; width: 100%; background: var(--primary-color); transform: scaleX(0); transform-origin: left; transition: transform 0.2s var(--ae-ease-out); }
  .progress .label { font-size: 0.85rem; color: var(--secondary-text-color); margin-top: 8px; }
  /* Status uses a high-contrast text colour on a tinted, thinly outlined box,
     so meaning is carried by the text and never by colour alone. */
  .status { margin-top: 20px; padding: 14px 16px; border-radius: 10px; font-size: 0.92rem; line-height: 1.45; display: none; color: var(--primary-text-color); border: 1px solid var(--divider-color, #ccc); }
  .status.show { display: block; }
  .status.error { background: rgba(var(--rgb-error-color, 219,68,55), 0.12); border-color: rgba(var(--rgb-error-color, 219,68,55), 0.5); }
  .status.empty { background: var(--secondary-background-color, #f3f3f3); border-color: var(--divider-color, #ccc); }
  .status.success { background: rgba(var(--rgb-success-color, 67,160,71), 0.12); border-color: rgba(var(--rgb-success-color, 67,160,71), 0.5); }
  .status.warn { background: rgba(var(--rgb-warning-color, 255,160,0), 0.14); border-color: rgba(var(--rgb-warning-color, 255,160,0), 0.5); }
  [hidden] { display: none !important; }
  .tabs { display: flex; gap: 4px; margin: 0 0 24px; border-bottom: 1px solid var(--divider-color, #ccc); }
  .tab {
    padding: 12px 16px;
    margin-bottom: -1px;
    border: 0;
    border-bottom: 3px solid transparent;
    background: none;
    color: var(--secondary-text-color);
    font: inherit;
    font-size: 1rem;
    cursor: pointer;
  }
  .tab:hover { color: var(--primary-text-color); }
  .tab[aria-selected="true"] { color: var(--primary-text-color); border-bottom-color: var(--primary-color); font-weight: 500; }
  h2.section-title { font-size: 1.15rem; margin: 0 0 4px; font-weight: 500; }
  h3.section-title { font-size: 1.02rem; margin: 0 0 12px; font-weight: 500; }
  .section-title:focus { outline: none; }
  .detail-row { flex-wrap: wrap; }
  .detail-info { flex: 1 1 220px; min-width: 0; }
  .detail-info .chosen-name { display: block; }
  .detail-info .help { margin: 4px 0 0; }
  .detail-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
  .detail-hint { margin: 0 0 24px; font-size: 0.92rem; color: var(--secondary-text-color); }
  button.link {
    border: 0;
    padding: 4px 2px;
    background: none;
    color: var(--primary-color);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .detail-editor fieldset.field { margin-bottom: 16px; }
  .detail-editor .toggle-row { margin-bottom: 10px; }
  /* Visible keyboard focus on every interactive control. */
  .chip:focus-visible, .tab:focus-visible, button.link:focus-visible, button.export:focus-visible, button.remove:focus-visible, .toggle-row input:focus-visible, .entity-fallback input:focus-visible { outline: 2px solid var(--primary-text-color); outline-offset: 2px; }
  .chip[aria-pressed="true"]:focus-visible, #export-csv:focus-visible { outline-color: var(--text-primary-color, #fff); }
  :host(.narrow) .card { padding: 16px; }
  :host(.narrow) button.export { flex-basis: 100%; }
  @media (prefers-reduced-motion: reduce) {
    .chip, button.export, .progress .bar { transition: none; }
  }
`;

class ActivityExporterPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._narrow = false;
    this._built = false;

    // Form state.
    this._entityIds = [];
    this._controlMode = null;
    this._preset = "7d";
    this._customStart = "";
    this._customEnd = "";
    this._skipRepeats = false;
    this._splitColumns = true;

    // Cache of raw (unfiltered) records per device, keyed by the sorted device
    // ids and the range, so switching format, order, "skip repeats" or "own
    // column" never refetches.
    this._cacheKey = null;
    this._cacheRecords = null;
    this._cacheCausesUnavailable = false;
    this._causesUnavailable = false;
    this._pickerExclusions = new WeakMap();

    this._busy = false;

    // Save-more-detail tab state.
    this._tab = "export";
    this._detailList = [];
    this._detailListLoaded = false;
    this._detailListFetched = false;
    this._detailTarget = null;
    this._describeCache = new Map();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._refreshEntityControl();
    this._syncTabs();
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

        <div class="tabs" role="tablist" aria-label="Sections" id="tabs" hidden>
          <button class="tab" type="button" role="tab" id="tab-export" aria-controls="panel-export" aria-selected="true">Export</button>
          <button class="tab" type="button" role="tab" id="tab-detail" aria-controls="panel-detail" aria-selected="false">Save more detail</button>
        </div>

        <div role="tabpanel" id="panel-export" aria-labelledby="tab-export">
        <div class="field" id="entity-field">
          <label class="title" id="entity-title" for="entity-add" tabindex="-1">What do you want to export?</label>
          <p class="help" id="entity-help" aria-live="polite">${ENTITY_HELP}</p>
          <ul class="chosen-list" id="chosen-list" aria-label="Chosen devices and sensors" hidden></ul>
          <div id="entity-control"></div>
        </div>

        <p class="detail-hint" id="detail-hint" hidden>Some details of this aren't saved. <button class="link" type="button" id="detail-hint-button">Save more detail</button></p>

        <fieldset class="field">
          <legend class="title">Time period</legend>
          <p class="help">Choose how far back to look.</p>
          <div class="presets"></div>
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
        </fieldset>

        <div class="field">
          <label class="toggle-row">
            <input type="checkbox" id="skip-repeats" />
            <span class="toggle-text">
              <span class="label">Skip repeats</span>
              <span class="help toggle-help">Leave out rows where neither the value nor any setting changed.</span>
            </span>
          </label>
        </div>

        <div class="field">
          <label class="toggle-row">
            <input type="checkbox" id="split-columns" checked />
            <span class="toggle-text">
              <span class="label">Give each setting its own column</span>
              <span class="help toggle-help">Puts things like temperature, position and mode in separate spreadsheet columns. Turn off for a simpler file with fewer columns.</span>
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

        <div class="progress" id="progress">
          <div class="track" id="progress-track" role="progressbar" aria-label="Gathering your history" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="bar" id="progress-bar"></div></div>
          <div class="label" id="progress-label" aria-hidden="true">Gathering history…</div>
        </div>

        <div class="status" id="status" role="status" aria-live="polite"></div>
        </div>

        <div role="tabpanel" id="panel-detail" aria-labelledby="tab-detail" hidden>
          <h2 class="section-title" id="detail-title" tabindex="-1">Save more detail</h2>
          <p class="help">Home Assistant leaves some details out of its history, like a light's brightness. Choose which of them to keep from now on, so they show up in your exports.</p>

          <div class="field">
            <span class="title" id="detail-list-title">Saving extra detail for</span>
            <p class="help" id="detail-empty">Nothing yet.</p>
            <ul class="chosen-list" id="detail-list" aria-labelledby="detail-list-title"></ul>
          </div>

          <div class="field">
            <label class="title" for="detail-add">Save detail for a device or sensor</label>
            <div id="detail-add-control"></div>
          </div>

          <div class="detail-editor" id="detail-editor" hidden></div>
          <div class="status" id="detail-status" role="status" aria-live="polite"></div>
        </div>
      </div>
    `;

    this._els = {
      entityControl: root.getElementById("entity-control"),
      entityTitle: root.getElementById("entity-title"),
      entityHelp: root.getElementById("entity-help"),
      chosenList: root.getElementById("chosen-list"),
      presets: root.querySelector(".presets"),
      customDates: root.getElementById("custom-dates"),
      startDate: root.getElementById("start-date"),
      endDate: root.getElementById("end-date"),
      skipRepeats: root.getElementById("skip-repeats"),
      splitColumns: root.getElementById("split-columns"),
      csvBtn: root.getElementById("export-csv"),
      jsonBtn: root.getElementById("export-json"),
      progress: root.getElementById("progress"),
      progressTrack: root.getElementById("progress-track"),
      progressBar: root.getElementById("progress-bar"),
      progressLabel: root.getElementById("progress-label"),
      status: root.getElementById("status"),
      tabs: root.getElementById("tabs"),
      tabExport: root.getElementById("tab-export"),
      tabDetail: root.getElementById("tab-detail"),
      panelExport: root.getElementById("panel-export"),
      panelDetail: root.getElementById("panel-detail"),
      detailHint: root.getElementById("detail-hint"),
      detailHintButton: root.getElementById("detail-hint-button"),
      detailTitle: root.getElementById("detail-title"),
      detailEmpty: root.getElementById("detail-empty"),
      detailList: root.getElementById("detail-list"),
      detailAddControl: root.getElementById("detail-add-control"),
      detailEditor: root.getElementById("detail-editor"),
      detailStatus: root.getElementById("detail-status"),
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
      // Clear any stale "downloaded N rows" banner from a previous export.
      this._updateButtons();
    });
    this._els.splitColumns.addEventListener("change", (e) => {
      this._splitColumns = e.target.checked;
      this._updateButtons();
    });
    this._els.csvBtn.addEventListener("click", () => this._export("csv"));
    this._els.jsonBtn.addEventListener("click", () => this._export("json"));
    this._els.tabExport.addEventListener("click", () => this._selectTab("export"));
    this._els.tabDetail.addEventListener("click", () => this._selectTab("detail"));
    for (const tab of [this._els.tabExport, this._els.tabDetail]) {
      tab.addEventListener("keydown", (e) => this._onTabKey(e));
    }
    this._els.detailHintButton.addEventListener("click", () => this._openDetailFor(this._entityIds[0]));

    this._refreshEntityControl();
    this._updateButtons();
    this._syncTabs();
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
    custom.setAttribute("aria-controls", "custom-dates");
    custom.setAttribute("aria-expanded", String(this._preset === "custom"));
    custom.addEventListener("click", () => this._selectPreset("custom"));
    group.appendChild(custom);
  }

  _selectPreset(key) {
    this._preset = key;
    for (const chip of this._els.presets.querySelectorAll(".chip")) {
      chip.setAttribute("aria-pressed", String(chip.dataset.preset === key));
    }
    const customChip = this._els.presets.querySelector('.chip[data-preset="custom"]');
    if (customChip) customChip.setAttribute("aria-expanded", String(key === "custom"));
    this._els.customDates.classList.toggle("open", key === "custom");
    this._invalidateCache();
    this._updateButtons();
  }

  // --- Entity selection ---------------------------------------------------

  /**
   * Sync the add control and chosen rows with the available Home Assistant elements and states.
   */
  _refreshEntityControl() {
    if (!this._built || !this._hass) return;
    const mode = customElements.get("ha-entity-picker") ? "picker" : "fallback";
    const modeChanged = this._controlMode !== mode;
    if (modeChanged) {
      this._controlMode = mode;
      this._buildAddControl();
      this._buildDetailAddControl();
    }
    if (mode === "fallback") {
      this._populateFallbackOptions();
      this._populateDetailOptions();
    } else {
      const pickers = [
        this._addControl(),
        this._els.detailAddControl.querySelector("ha-entity-picker"),
        ...this._els.chosenList.querySelectorAll("ha-entity-picker"),
      ].filter(Boolean);
      for (const picker of pickers) {
        if (picker.hass !== this._hass) picker.hass = this._hass;
      }
    }
    if (modeChanged) this._renderChosen();
    this._syncSelectionControls();
  }

  /**
   * Return the element that adds another device: the picker or the fallback input.
   */
  _addControl() {
    return this._els.entityControl.querySelector("#entity-add");
  }

  /**
   * Build the control that adds one device: ha-entity-picker when available, else a datalist input.
   */
  _buildAddControl() {
    const host = this._els.entityControl;
    host.innerHTML = "";
    if (this._controlMode === "picker") {
      const picker = document.createElement("ha-entity-picker");
      picker.id = "entity-add";
      picker.allowCustomEntity = false;
      picker.addEventListener("value-changed", (e) => {
        const id = e.detail.value || "";
        if (!id) return;
        this._addEntity(id);
        picker.value = "";
      });
      host.appendChild(picker);
      return;
    }

    // Fallback: a searchable text input backed by a datalist. Used only when
    // ha-entity-picker is not available in the running Home Assistant build.
    this._fallbackSignature = null;
    const wrap = document.createElement("div");
    wrap.className = "entity-fallback";
    const input = document.createElement("input");
    input.type = "text";
    input.id = "entity-add";
    input.setAttribute("list", "entity-options");
    input.placeholder = "Start typing a name…";
    const list = document.createElement("datalist");
    list.id = "entity-options";
    input.addEventListener("change", () => {
      const id = this._resolveFallbackValue(input.value);
      if (!id) return;
      this._addEntity(id);
      input.value = "";
    });
    wrap.appendChild(input);
    wrap.appendChild(list);
    host.appendChild(wrap);
  }

  /**
   * Rebuild every chosen row from the current selection.
   */
  _renderChosen() {
    const list = this._els.chosenList;
    list.innerHTML = "";
    for (const id of this._entityIds) list.appendChild(this._createRow(id));
    this._syncSelectionControls();
  }

  /**
   * Name to show for a chosen device: the friendly name, with its id to tell duplicate names apart in the fallback.
   */
  _choiceLabel(id) {
    if (this._controlMode === "fallback" && this._fallbackDisplay?.has(id)) {
      return this._fallbackDisplay.get(id);
    }
    return this._hass?.states?.[id]?.attributes?.friendly_name || id;
  }

  /**
   * Build one chosen row: a picker, which clears itself out with its own X, or a name with a button that removes it.
   */
  _createRow(id) {
    const row = document.createElement("li");
    row.className = "chosen-row";
    row.dataset.id = id;
    if (this._controlMode === "picker") {
      const picker = document.createElement("ha-entity-picker");
      picker.allowCustomEntity = false;
      picker.hass = this._hass;
      picker.value = id;
      picker.addEventListener("value-changed", (e) => this._changeChosen(row, e.detail.value || "", picker));
      row.appendChild(picker);
      return row;
    }
    const name = document.createElement("span");
    name.className = "chosen-name";
    name.textContent = this._choiceLabel(id);
    row.appendChild(name);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => this._removeEntity(row.dataset.id));
    remove.addEventListener("keydown", (e) => {
      if (e.key === "Delete") {
        e.preventDefault();
        this._removeEntity(row.dataset.id);
      }
    });
    row.appendChild(remove);
    return row;
  }

  /**
   * Handle a chosen row's picker changing: clear removes it, an unused device swaps in, a duplicate is undone.
   */
  _changeChosen(row, next, picker) {
    const current = row.dataset.id;
    if (next === current) return;
    if (!next) {
      this._removeEntity(current);
      return;
    }
    if (this._entityIds.includes(next)) {
      picker.value = current;
      return;
    }
    this._entityIds = this._entityIds.map((id) => (id === current ? next : id));
    row.dataset.id = next;
    this._syncSelectionControls();
    this._updateButtons();
  }

  /**
   * Add one device to the end of the selection, ignoring duplicates and anything past the cap.
   */
  _addEntity(id) {
    if (!id || this._entityIds.includes(id) || this._entityIds.length >= MAX_ENTITIES) return;
    this._entityIds = [...this._entityIds, id];
    this._els.chosenList.appendChild(this._createRow(id));
    this._syncSelectionControls();
    this._updateButtons();
    if (this._entityIds.length >= MAX_ENTITIES && !this._focusRemoveButton(MAX_ENTITIES - 1)) this._focusAddControl();
  }

  /**
   * Remove one device from the selection and move focus to a control that is still there.
   */
  _removeEntity(id) {
    const index = this._entityIds.indexOf(id);
    if (index === -1) return;
    this._entityIds = this._entityIds.filter((other) => other !== id);
    for (const row of this._els.chosenList.querySelectorAll(".chosen-row")) {
      if (row.dataset.id === id) row.remove();
    }
    this._syncSelectionControls();
    this._updateButtons();
    if (!this._focusRemoveButton(index)) this._focusAddControl();
  }

  /**
   * Focus the add control, or the field title when the control cannot take focus.
   */
  _focusAddControl() {
    const add = this._addControl();
    add?.focus?.();
    const active = this.shadowRoot.activeElement;
    if (add && active && (active === add || add.contains(active))) return;
    this._els.entityTitle.focus();
  }

  /**
   * Focus the remove button at an index, or the last one; returns false when there is none.
   */
  _focusRemoveButton(index) {
    const buttons = this._els.chosenList.querySelectorAll("button.remove");
    const target = buttons[Math.min(index, buttons.length - 1)];
    if (!target) return false;
    target.focus();
    return true;
  }

  /**
   * Update labels, exclusions, help text and visibility to match the current selection.
   */
  _syncSelectionControls() {
    const ids = this._entityIds;
    const full = ids.length >= MAX_ENTITIES;
    this._els.chosenList.hidden = ids.length === 0;
    this._els.entityControl.hidden = full;
    const helpText = full ? ENTITY_HELP_FULL : ENTITY_HELP;
    if (this._els.entityHelp.textContent !== helpText) this._els.entityHelp.textContent = helpText;

    if (this._controlMode === "picker") {
      const add = this._addControl();
      if (add) {
        this._configurePicker(add, ids.length ? "Add another device or sensor" : "Add a device or sensor", ids);
      }
      this._els.chosenList.querySelectorAll(".chosen-row").forEach((row, index) => {
        const picker = row.querySelector("ha-entity-picker");
        if (!picker) return;
        this._configurePicker(
          picker,
          `Device or sensor ${index + 1}`,
          ids.filter((id) => id !== row.dataset.id)
        );
      });
    } else {
      this._populateFallbackOptions();
    }
    this._els.chosenList.querySelectorAll(".chosen-row").forEach((row) => {
      const label = this._choiceLabel(row.dataset.id);
      const remove = row.querySelector("button.remove");
      const removeLabel = `Remove ${label}`;
      if (remove && remove.getAttribute("aria-label") !== removeLabel) remove.setAttribute("aria-label", removeLabel);
      const name = row.querySelector(".chosen-name");
      if (name && name.textContent !== label) name.textContent = label;
    });
  }

  /**
   * Set a picker's label and excluded devices, touching the element only when either has changed.
   */
  _configurePicker(picker, label, excluded) {
    if (picker.label !== label) picker.label = label;
    const signature = excluded.join(",");
    if (this._pickerExclusions.get(picker) === signature) return;
    this._pickerExclusions.set(picker, signature);
    picker.excludeEntities = [...excluded];
  }

  /**
   * Fill the fallback datalist with every device not yet chosen, using friendly names.
   */
  _populateFallbackOptions() {
    const list = this._els.entityControl.querySelector("#entity-options");
    if (!list) return;
    const states = this._hass.states || {};
    const ids = Object.keys(states).sort();
    // Only rebuild when the device count or the chosen devices change, to avoid clobbering on every tick.
    const signature = `${ids.length}|${this._entityIds.join(",")}`;
    if (this._fallbackMap && this._fallbackSignature === signature) return;
    this._fallbackSignature = signature;

    // Show friendly names; only fall back to the raw id to disambiguate
    // genuinely duplicate names. Keep a display -> id map for resolution.
    const nameCounts = {};
    for (const id of ids) {
      const name = states[id]?.attributes?.friendly_name || id;
      nameCounts[name] = (nameCounts[name] || 0) + 1;
    }
    const chosen = new Set(this._entityIds);
    this._fallbackMap = new Map();
    this._fallbackDisplay = new Map();
    list.innerHTML = "";
    for (const id of ids) {
      const friendly = states[id]?.attributes?.friendly_name || id;
      const display = nameCounts[friendly] > 1 ? `${friendly} (${id})` : friendly;
      this._fallbackMap.set(display, id);
      this._fallbackDisplay.set(id, display);
      if (chosen.has(id)) continue;
      const opt = document.createElement("option");
      opt.value = display;
      list.appendChild(opt);
    }
  }

  _resolveFallbackValue(value) {
    const v = (value || "").trim();
    if (!v) return "";
    // Prefer the display -> id map built when options were populated.
    if (this._fallbackMap && this._fallbackMap.has(v)) {
      return this._fallbackMap.get(v);
    }
    // Also accept a bare entity id or an exact friendly-name match.
    if (this._hass.states[v]) return v;
    for (const [id, st] of Object.entries(this._hass.states || {})) {
      if ((st.attributes?.friendly_name || "") === v) return id;
    }
    return "";
  }

  // --- Save more detail ---------------------------------------------------

  /**
   * Ask which devices and sensors have extra details saved, resolving to a list of entries.
   */
  _listDetails() {
    return this._hass.callWS({ type: WS_DETAIL_LIST });
  }

  /**
   * Ask which details one device or sensor has and which of them Home Assistant leaves out of its history.
   */
  _describeDetails(entityId) {
    return this._hass.callWS({ type: WS_DETAIL_DESCRIBE, entity_id: entityId });
  }

  /**
   * Save the chosen details for one device or sensor; an empty list stops saving.
   */
  _saveDetails(entityId, attributes) {
    return this._hass.callWS({ type: WS_DETAIL_SAVE, entity_id: entityId, attributes });
  }

  /**
   * Whether the signed-in person may choose which details are saved.
   */
  _isAdmin() {
    return !!this._hass?.user?.is_admin;
  }

  /**
   * Show the tab bar for admins, fall back to the Export tab for anyone else, and load the saved list once.
   */
  _syncTabs() {
    if (!this._built || !this._hass) return;
    const admin = this._isAdmin();
    this._els.tabs.hidden = !admin;
    if (!admin && this._tab !== "export") this._selectTab("export");
    if (admin && !this._detailListLoaded) {
      this._detailListLoaded = true;
      this._refreshDetailList();
    }
  }

  /**
   * Show one tab's section and hide the other.
   */
  _selectTab(tab) {
    this._tab = tab;
    const detail = tab === "detail";
    this._els.tabExport.setAttribute("aria-selected", String(!detail));
    this._els.tabDetail.setAttribute("aria-selected", String(detail));
    this._els.panelExport.hidden = detail;
    this._els.panelDetail.hidden = !detail;
    if (detail) {
      this._renderDetailList();
      this._refreshDetailList();
    }
  }

  /**
   * Move between the two tabs with the arrow keys.
   */
  _onTabKey(e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = this._tab === "export" ? "detail" : "export";
    this._selectTab(next);
    (next === "detail" ? this._els.tabDetail : this._els.tabExport).focus();
  }

  /**
   * Switch to the Save more detail tab and start choosing details for one device or sensor.
   */
  _openDetailFor(entityId) {
    if (!entityId) return;
    this._selectTab("detail");
    this._chooseDetailTarget(entityId);
  }

  /**
   * Reload the saved list, resolving to false when the request fails.
   */
  async _refreshDetailList() {
    try {
      this._detailList = await this._listDetails();
    } catch {
      this._detailListFetched = false;
      return false;
    }
    this._detailListFetched = true;
    this._renderDetailList();
    this._updateDetailHint();
    return true;
  }

  /**
   * Show or hide the Export tab's hint when the one chosen thing has details that are not saved.
   */
  _updateDetailHint() {
    const hint = this._els?.detailHint;
    if (!hint) return;
    const id = this._entityIds.length === 1 ? this._entityIds[0] : null;
    const eligible =
      !!id && this._isAdmin() && !this._detailList.some((entry) => entry.source_entity_id === id);
    if (!eligible) {
      hint.hidden = true;
      return;
    }
    if (!this._describeCache.has(id)) {
      this._describeCache.set(id, null);
      this._describeDetails(id)
        .then((result) => this._describeCache.set(id, result.details || []))
        .catch(() => this._describeCache.set(id, null))
        .then(() => this._updateDetailHint());
      hint.hidden = true;
      return;
    }
    const details = this._describeCache.get(id);
    hint.hidden = !(details && details.some((detail) => detail.unrecorded));
  }

  /**
   * Build the control that picks a device to save details for: ha-entity-picker when available, else a datalist input.
   */
  _buildDetailAddControl() {
    const host = this._els.detailAddControl;
    host.innerHTML = "";
    if (this._controlMode === "picker") {
      const picker = document.createElement("ha-entity-picker");
      picker.id = "detail-add";
      picker.allowCustomEntity = false;
      picker.label = "Choose a device or sensor";
      picker.addEventListener("value-changed", (e) => {
        const id = e.detail.value || "";
        if (!id) return;
        this._chooseDetailTarget(id);
        picker.value = "";
      });
      host.appendChild(picker);
      return;
    }
    this._detailOptionsSignature = null;
    const wrap = document.createElement("div");
    wrap.className = "entity-fallback";
    const input = document.createElement("input");
    input.type = "text";
    input.id = "detail-add";
    input.setAttribute("list", "detail-options");
    input.placeholder = "Start typing a name…";
    const list = document.createElement("datalist");
    list.id = "detail-options";
    input.addEventListener("change", () => {
      const id = this._resolveFallbackValue(input.value);
      if (!id) return;
      this._chooseDetailTarget(id);
      input.value = "";
    });
    wrap.appendChild(input);
    wrap.appendChild(list);
    host.appendChild(wrap);
  }

  /**
   * Fill the Save more detail datalist with every device's friendly name.
   */
  _populateDetailOptions() {
    const list = this._els.detailAddControl.querySelector("#detail-options");
    if (!list || !this._fallbackDisplay) return;
    const signature = `${this._fallbackDisplay.size}`;
    if (this._detailOptionsSignature === signature) return;
    this._detailOptionsSignature = signature;
    list.innerHTML = "";
    for (const display of this._fallbackDisplay.values()) {
      const opt = document.createElement("option");
      opt.value = display;
      list.appendChild(opt);
    }
  }

  /**
   * Show a message under the Save more detail tab.
   */
  _showDetailStatus(kind, message) {
    this._els.detailStatus.className = `status show ${kind}`;
    this._els.detailStatus.textContent = message;
  }

  /**
   * Clear the Save more detail tab's message.
   */
  _hideDetailStatus() {
    this._els.detailStatus.className = "status";
    this._els.detailStatus.textContent = "";
  }

  /**
   * Turn a list of detail names into readable labels joined with commas.
   */
  _detailLabels(names) {
    return detailChoices(names.map((name) => ({ name, unrecorded: false, volatile: false })))
      .map((choice) => choice.label)
      .join(", ");
  }

  /**
   * Rebuild the list of things that have extra details saved.
   */
  _renderDetailList() {
    const list = this._els.detailList;
    list.innerHTML = "";
    for (const entry of this._detailList) list.appendChild(this._createDetailRow(entry));
    this._els.detailEmpty.hidden = this._detailList.length > 0;
  }

  /**
   * Build one saved row: the name, its saved details, and Change and Stop saving buttons.
   */
  _createDetailRow(entry) {
    const id = entry.source_entity_id;
    const exists = !!this._hass?.states?.[id];
    const name = this._hass?.states?.[id]?.attributes?.friendly_name || id;
    const row = document.createElement("li");
    row.className = "chosen-row detail-row";
    row.dataset.id = id;

    const info = document.createElement("div");
    info.className = "detail-info";
    const title = document.createElement("span");
    title.className = "chosen-name";
    title.textContent = name;
    info.appendChild(title);
    const saved = entry.attributes || [];
    const dropped = entry.dropped || [];
    const lines = [];
    if (saved.length) lines.push(`Saving: ${this._detailLabels(saved)}`);
    if (dropped.length) lines.push(`Too large to save: ${this._detailLabels(dropped)}`);
    if (!exists) lines.push("Can't find this any more");
    for (const line of lines) {
      const p = document.createElement("p");
      p.className = "help";
      p.textContent = line;
      info.appendChild(p);
    }
    row.appendChild(info);

    const buttons = document.createElement("div");
    buttons.className = "detail-buttons";
    if (exists) {
      const change = document.createElement("button");
      change.type = "button";
      change.className = "remove";
      change.textContent = "Change";
      change.setAttribute("aria-label", `Change what is saved for ${name}`);
      change.addEventListener("click", () => this._chooseDetailTarget(id));
      buttons.appendChild(change);
    }
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "remove";
    stop.textContent = "Stop saving";
    stop.setAttribute("aria-label", `Stop saving detail for ${name}`);
    stop.addEventListener("click", () => this._stopSaving(id, name));
    buttons.appendChild(stop);
    row.appendChild(buttons);
    return row;
  }

  /**
   * Stop saving extra detail for one device or sensor and refresh the list.
   */
  async _stopSaving(id, name) {
    this._hideDetailStatus();
    try {
      await this._saveDetails(id, []);
    } catch {
      this._showDetailStatus("error", "That didn't work. Please try again.");
      return;
    }
    if (this._detailTarget === id) this._closeDetailEditor();
    const refreshed = await this._refreshDetailList();
    this._showDetailStatus(
      "success",
      `No longer saving extra detail for ${name}.${refreshed ? "" : STALE_LIST_NOTE}`
    );
    this._els.detailTitle.focus();
  }

  /**
   * Look up a device's details and show the checkboxes for choosing which to save.
   */
  async _chooseDetailTarget(id) {
    this._detailTarget = id;
    this._hideDetailStatus();
    this._els.detailEditor.hidden = true;
    this._showDetailStatus("empty", "Looking at what can be saved…");
    let result;
    try {
      result = await this._describeDetails(id);
    } catch (err) {
      if (this._detailTarget !== id) return;
      this._detailTarget = null;
      this._showDetailStatus(
        "error",
        err?.code === "not_found"
          ? "Can't find this any more."
          : "We couldn't look up the details for this. Please try again."
      );
      return;
    }
    if (this._detailTarget !== id) return;
    this._hideDetailStatus();
    this._renderDetailEditor(id, result);
  }

  /**
   * Hide the checkbox editor.
   */
  _closeDetailEditor() {
    this._detailTarget = null;
    this._els.detailEditor.hidden = true;
    this._els.detailEditor.innerHTML = "";
  }

  /**
   * Build the editor: details Home Assistant leaves out first, then ones it already keeps, with Save and Cancel.
   */
  _renderDetailEditor(id, result) {
    const editor = this._els.detailEditor;
    editor.innerHTML = "";
    const savedEntry = this._detailList.find((entry) => entry.source_entity_id === id);
    const saved = new Set(savedEntry ? savedEntry.attributes : []);
    const details = withSavedDetails(result.details || [], [...saved]);
    const choices = detailChoices(details);
    const name = result.name || this._hass?.states?.[id]?.attributes?.friendly_name || id;

    const heading = document.createElement("h3");
    heading.className = "section-title";
    heading.tabIndex = -1;
    heading.textContent = name;
    editor.appendChild(heading);

    const inputs = [];
    const group = (legend, items) => {
      if (!items.length) return;
      const fieldset = document.createElement("fieldset");
      fieldset.className = "field";
      const lg = document.createElement("legend");
      lg.className = "title";
      lg.textContent = legend;
      fieldset.appendChild(lg);
      for (const choice of items) {
        const label = document.createElement("label");
        label.className = "toggle-row";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = choice.name;
        input.checked = savedEntry ? saved.has(choice.name) : choice.checked;
        input.addEventListener("change", syncSave);
        inputs.push(input);
        const text = document.createElement("span");
        text.className = "toggle-text";
        const main = document.createElement("span");
        main.className = "label";
        main.textContent = choice.label;
        text.appendChild(main);
        if (choice.note) {
          const note = document.createElement("span");
          note.className = "help toggle-help";
          note.textContent = choice.note;
          text.appendChild(note);
        }
        label.appendChild(input);
        label.appendChild(text);
        fieldset.appendChild(label);
      }
      editor.appendChild(fieldset);
    };

    const missing = choices.filter((_, i) => details[i].unrecorded);
    const kept = choices.filter((_, i) => !details[i].unrecorded);
    const actions = document.createElement("div");
    actions.className = "actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "export";
    save.textContent = "Save";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "export secondary";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      this._closeDetailEditor();
      this._els.detailTitle.focus();
    });

    /** Turn Save on only while at least one detail is ticked. */
    function syncSave() {
      save.disabled = !inputs.some((input) => input.checked);
    }

    if (!missing.length) {
      const none = document.createElement("p");
      none.className = "help";
      none.textContent = "Everything about this is already saved.";
      editor.appendChild(none);
      actions.appendChild(cancel);
    } else {
      group("Home Assistant doesn't keep these", missing);
      group("Already kept", kept);
      save.addEventListener("click", () =>
        this._submitDetails(id, name, inputs.filter((input) => input.checked).map((input) => input.value))
      );
      actions.appendChild(save);
      actions.appendChild(cancel);
      syncSave();
    }
    editor.appendChild(actions);
    editor.hidden = false;
    heading.focus();
  }

  /**
   * Save the ticked details, then refresh the list and say what happens next.
   */
  async _submitDetails(id, name, names) {
    this._hideDetailStatus();
    try {
      await this._saveDetails(id, names);
    } catch {
      this._showDetailStatus("error", "That didn't save. Please try again.");
      return;
    }
    this._closeDetailEditor();
    const refreshed = await this._refreshDetailList();
    this._showDetailStatus(
      "success",
      `Saving from now on. Earlier history doesn't have these details.${refreshed ? "" : STALE_LIST_NOTE}`
    );
    this._els.detailTitle.focus();
  }

  // --- Time range ---------------------------------------------------------

  _computeRange() {
    // Custom wall-clock dates are interpreted in the Home Assistant time zone
    // (not the browser's) so the queried window matches the exported timestamps.
    return computeRange(
      this._preset,
      this._customStart,
      this._customEnd,
      Date.now(),
      this._hass?.config?.time_zone
    );
  }

  _rangeValid() {
    const { startMs, endMs } = this._computeRange();
    return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
  }

  // --- Buttons / status ---------------------------------------------------

  _updateButtons() {
    this._updateDetailHint();
    const hasEntity = this._entityIds.length > 0;
    const ready = hasEntity && this._rangeValid() && !this._busy;
    this._els.csvBtn.disabled = !ready;
    this._els.jsonBtn.disabled = !ready;

    if (this._busy) return;

    // Guidance also clears any stale result banner whenever inputs change.
    if (!hasEntity) {
      this._showStatus(
        "empty",
        "Pick a device or sensor above to turn on the download buttons."
      );
    } else if (this._preset === "custom" && !this._rangeValid()) {
      this._showStatus(
        "warn",
        "Please choose a valid date range — the “To” date must be after the “From” date."
      );
    } else {
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
    this._els.progressBar.style.transform = `scaleX(${percent / 100})`;
    this._els.progressTrack.setAttribute("aria-valuenow", String(percent));
    if (label) this._els.progressLabel.textContent = label;
  }

  _hideProgress() {
    this._els.progress.classList.remove("show");
    this._els.progressBar.style.transform = "scaleX(0)";
    this._els.progressTrack.setAttribute("aria-valuenow", "0");
  }

  _invalidateCache() {
    this._cacheKey = null;
    this._cacheRecords = null;
    this._cacheCausesUnavailable = false;
  }

  // --- Export -------------------------------------------------------------

  /**
   * Fetch the history for the chosen devices and download it as a CSV or JSON file.
   */
  async _export(format) {
    if (this._busy || !this._entityIds.length || !this._rangeValid()) return;
    const entityIds = [...this._entityIds];
    const { startMs, endMs } = this._computeRange();

    this._busy = true;
    this._updateButtons();
    this._hideStatus();

    let recordsById;
    try {
      recordsById = await this._loadRecords(entityIds, startMs, endMs);
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

    const many = entityIds.length > 1;
    const hasRows = entityIds.some((id) => (recordsById.get(id) || []).length > 0);
    if (!hasRows) {
      this._showStatus(
        "empty",
        many
          ? "We couldn't find any history for these devices or sensors in the time period you chose. Try a longer time period. Some devices don't keep a long history."
          : "We couldn't find any history for this device or sensor in the time period you chose. Try a longer time period — some devices don't keep a long history."
      );
      return;
    }

    const states = this._hass.states;
    const groups = buildExportGroups(entityIds, recordsById, states, this._skipRepeats);
    const rowCount = groups.reduce((total, group) => total + group.records.length, 0);
    const timeZone = this._hass.config?.time_zone;
    const meta = {
      exportedAtMs: Date.now(),
      periodStartMs: startMs,
      periodEndMs: endMs,
      stateChangesOnly: this._skipRepeats,
    };
    const csvOptions = { splitColumns: this._splitColumns, userNames: userNamesFromStates(states) };

    let content;
    let mime;
    let ext;
    if (format === "csv") {
      content = many
        ? toMultiCsv(groups, timeZone, csvOptions)
        : toCsv(groups[0].records, timeZone, csvOptions);
      mime = "text/csv;charset=utf-8";
      ext = "csv";
    } else {
      content = many
        ? toMultiJson(meta, groups, timeZone)
        : toJson(
            { ...meta, entityId: groups[0].entityId, friendlyName: groups[0].friendlyName },
            groups[0].records,
            timeZone
          );
      mime = "application/json;charset=utf-8";
      ext = "json";
    }

    const filename = many
      ? buildMultiFilename(entityIds.length, startMs, endMs, ext, timeZone)
      : buildFilename(entityIds[0], startMs, endMs, ext, timeZone);
    this._downloadFile(filename, content, mime);

    const kind = rowCount > LARGE_RESULT_THRESHOLD ? "warn" : "success";
    const noHistory = describeMissingHistory(
      groups.filter((group) => !group.records.length).map((group) => group.friendlyName || group.entityId)
    );
    const noCauses = this._causesUnavailable
      ? " It doesn't say what caused each change, because that information wasn't available this time."
      : "";
    const big =
      kind === "warn"
        ? " That's a lot of rows — if your spreadsheet struggles, try a shorter period or turn on “Skip repeats”."
        : "";
    this._showStatus(
      kind,
      `Downloaded ${rowCount.toLocaleString()} row${rowCount === 1 ? "" : "s"} as ${filename}.${noHistory ? ` ${noHistory}` : ""}${big}${noCauses}`
    );
  }

  /**
   * Fetch (or reuse) every chosen device's records for the range, resolving to a Map of id to records with causes attached.
   */
  async _loadRecords(entityIds, startMs, endMs) {
    const detailList = this._detailListFetched
      ? this._detailList
      : await this._listDetails().catch(() => []);
    const mirrorBySource = new Map();
    for (const id of entityIds) {
      const entry = detailList.find((item) => item.source_entity_id === id && item.mirror_entity_id);
      if (entry) mirrorBySource.set(id, entry.mirror_entity_id);
    }
    const requestIds = [...entityIds, ...mirrorBySource.values()];
    const key = buildCacheKey(requestIds, startMs, endMs, detailList);
    const startISO = new Date(startMs).toISOString();
    const endISO = new Date(endMs).toISOString();
    const chunks = chunkRangeByDay(startISO, endISO);

    if (this._cacheKey === key && this._cacheRecords) {
      const cached = this._cacheRecords;
      const retrying = this._cacheCausesUnavailable;
      const records = retrying ? await this._retryCauses(key, chunks, cached) : cached;
      this._causesUnavailable = retrying && records === cached;
      return records;
    }

    this._setProgress(0, "Gathering history… 0%");
    const collected = new Map(requestIds.map((id) => [id, []]));
    const entries = new Map(entityIds.map((id) => [id, []]));
    let causesAvailable = true;
    for (let i = 0; i < chunks.length; i++) {
      // Causes are optional: the first failed logbook request turns them off for this export.
      const logbookRequest = causesAvailable ? this._requestLogbook(entityIds, chunks[i]) : null;
      const result = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: chunks[i].start,
        end_time: chunks[i].end,
        entity_ids: requestIds,
        // Only the first chunk seeds the starting value; later chunks must not
        // re-emit the carried-over value or we'd get duplicate boundary rows.
        include_start_time_state: i === 0,
        significant_changes_only: false,
        minimal_response: false,
        no_attributes: false,
      });
      for (const id of requestIds) {
        collected.set(id, collected.get(id).concat(parseHistoryRecords(result, id)));
      }
      if (logbookRequest) {
        const logbook = await logbookRequest;
        if (logbook === null) {
          causesAvailable = false;
          for (const id of entityIds) entries.set(id, []);
        } else {
          for (const id of entityIds) {
            entries.set(id, entries.get(id).concat(parseLogbookEntries(logbook, id)));
          }
        }
      }
      const percent = Math.round(((i + 1) / chunks.length) * 100);
      this._setProgress(percent, `Gathering history… ${percent}%`);
    }

    const records = new Map(
      entityIds.map((id) => {
        const mirrorId = mirrorBySource.get(id);
        const raw = mirrorId ? mergeMirrorRecords(collected.get(id), collected.get(mirrorId)) : collected.get(id);
        return [id, attachCauses(normaliseRecords(raw), entries.get(id))];
      })
    );
    this._causesUnavailable = !causesAvailable;
    this._cacheKey = key;
    this._cacheRecords = records;
    this._cacheCausesUnavailable = !causesAvailable;
    return records;
  }

  /**
   * Request one chunk's logbook entries for several devices, resolving to null when the request fails.
   */
  _requestLogbook(entityIds, chunk) {
    return this._hass
      .callWS({
        type: "logbook/get_events",
        start_time: chunk.start,
        end_time: chunk.end,
        entity_ids: entityIds,
      })
      .catch(() => null);
  }

  /**
   * Fetch the logbook again for the given records and return them with causes attached, or the same records if any chunk fails.
   */
  async _retryCauses(key, chunks, cached) {
    const entityIds = [...cached.keys()];
    const entries = new Map(entityIds.map((id) => [id, []]));
    for (const chunk of chunks) {
      const logbook = await this._requestLogbook(entityIds, chunk);
      if (logbook === null) return cached;
      for (const id of entityIds) {
        entries.set(id, entries.get(id).concat(parseLogbookEntries(logbook, id)));
      }
    }
    const records = new Map(entityIds.map((id) => [id, attachCauses(cached.get(id), entries.get(id))]));
    if (this._cacheKey === key) {
      this._cacheRecords = records;
      this._cacheCausesUnavailable = false;
    }
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
