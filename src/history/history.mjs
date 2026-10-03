// Pure shaping of transcript events into the records the promotion engine reads, plus a compact
// on-disk encoding for handing a large history from the Node scanner to the mod.
//
// The engine (src/detect.mjs) needs each tool call as `{ action, preceding_event, session_id,
// timestamp }`, where `preceding_event` is the previous action in the same session. Praxis 1
// tracked that live with a per-session marker file; from a transcript it is derived after the
// fact by ordering each session's calls by time.

/**
 * @typedef {import("./transcript.mjs").ToolEvent} ToolEvent
 * @typedef {import("./transcript.mjs").PromptEvent} PromptEvent
 */

/**
 * @typedef {object} HistoryRecord
 * @property {string} action
 * @property {string} preceding_event
 * @property {string} session_id
 * @property {string} timestamp
 * @property {string} project
 * @property {string} [file]
 * @property {string} [model]
 * @property {string} [raw]
 */

/**
 * @typedef {object} History
 * @property {HistoryRecord[]} records                                  Tool calls, engine-ready.
 * @property {Array<{ session_id: string, timestamp: string, interrupted: boolean }>} prompts
 */

/** Order by session, then time; the sort is stable, so calls in one message keep their order. */
function bySessionThenTime(a, b) {
  return a.sessionId < b.sessionId
    ? -1
    : a.sessionId > b.sessionId
      ? 1
      : a.timestamp < b.timestamp
        ? -1
        : a.timestamp > b.timestamp
          ? 1
          : 0;
}

/**
 * Build engine-ready records from parsed transcript events.
 * @param {Array<ToolEvent | PromptEvent>} events
 * @returns {History}
 */
export function buildHistory(events) {
  const tools = events.filter((e) => e.kind === "tool").sort(bySessionThenTime);

  const records = [];
  let session = null;
  let preceding = "session_start";
  for (const e of tools) {
    if (e.sessionId !== session) {
      session = e.sessionId;
      preceding = "session_start";
    }
    /** @type {HistoryRecord} */
    const record = {
      action: e.action,
      preceding_event: preceding,
      session_id: e.sessionId,
      timestamp: e.timestamp,
      project: e.project,
    };
    if (e.file) record.file = e.file;
    if (e.model) record.model = e.model;
    if (e.raw) record.raw = e.raw;
    records.push(record);
    preceding = e.action;
  }

  const prompts = events
    .filter((e) => e.kind === "prompt")
    .map((e) => ({ session_id: e.sessionId, timestamp: e.timestamp, interrupted: e.interrupted }));

  return { records, prompts };
}

/**
 * Append live tool calls (seen by the mod during this session) to a history, continuing each
 * session's `preceding_event` chain from where the history left it.
 * @param {HistoryRecord[]} records   Existing records, in buildHistory order.
 * @param {Array<{ action: string, session_id: string, timestamp: string, project: string,
 *   file?: string, raw?: string }>} live
 * @returns {HistoryRecord[]}
 */
export function appendLive(records, live) {
  const lastAction = new Map();
  for (const r of records) lastAction.set(r.session_id, r.action);

  const out = records.slice();
  for (const call of live) {
    const record = { ...call, preceding_event: lastAction.get(call.session_id) ?? "session_start" };
    lastAction.set(call.session_id, call.action);
    out.push(record);
  }
  return out;
}

// --- Compact encoding -------------------------------------------------------------------------
//
// A heavy user's history runs to tens of thousands of calls, and the mod reads the scanner's
// output with `$.fs.read`, which caps one file at 4 MiB. Each record therefore travels as a short
// array of numbers: seconds since the epoch plus indexes into string tables. `preceding_event` is
// not stored at all; decoding re-derives it from the order, exactly as buildHistory does.

const FORMAT_VERSION = 1;

/** Intern strings into a table, returning each one's index. */
function interner() {
  const table = [];
  const index = new Map();
  return {
    table,
    id(value) {
      if (value === undefined) return -1;
      let i = index.get(value);
      if (i === undefined) {
        i = table.length;
        table.push(value);
        index.set(value, i);
      }
      return i;
    },
  };
}

/** Milliseconds-precision ISO time to whole seconds, and back. */
const toSeconds = (iso) => Math.floor(Date.parse(iso) / 1000);
const fromSeconds = (s) => new Date(s * 1000).toISOString();

/**
 * Encode a history into a compact, JSON-safe object.
 * @param {History} history
 * @returns {object}
 */
export function encodeHistory({ records, prompts }) {
  const sessions = interner();
  const actions = interner();
  const projects = interner();
  const files = interner();
  const models = interner();
  const raws = interner();

  const rows = records.map((r) => {
    const row = [
      toSeconds(r.timestamp),
      sessions.id(r.session_id),
      actions.id(r.action),
      projects.id(r.project),
      files.id(r.file),
      models.id(r.model),
      raws.id(r.raw),
    ];
    while (row.length > 4 && row[row.length - 1] === -1) row.pop(); // trailing absences are implied
    return row;
  });

  return {
    v: FORMAT_VERSION,
    sessions: sessions.table,
    actions: actions.table,
    projects: projects.table,
    files: files.table,
    models: models.table,
    raws: raws.table,
    rows,
    prompts: prompts.map((p) => [
      toSeconds(p.timestamp),
      sessions.id(p.session_id),
      p.interrupted ? 1 : 0,
    ]),
  };
}

/**
 * Decode what encodeHistory produced. Rows were written in buildHistory order, so a single pass
 * re-derives each session's `preceding_event` chain.
 * @param {any} data
 * @returns {History}
 */
export function decodeHistory(data) {
  if (!data || data.v !== FORMAT_VERSION) throw new Error("unsupported history format");
  const at = (table, i) => (i === undefined || i < 0 ? undefined : table[i]);

  const records = [];
  let session = null;
  let preceding = "session_start";
  for (const row of data.rows) {
    const [seconds, s, a, p, f, m, x] = row;
    const sessionId = data.sessions[s];
    if (sessionId !== session) {
      session = sessionId;
      preceding = "session_start";
    }
    const record = {
      action: data.actions[a],
      preceding_event: preceding,
      session_id: sessionId,
      timestamp: fromSeconds(seconds),
      project: data.projects[p],
    };
    const file = at(data.files, f);
    const model = at(data.models, m);
    const raw = at(data.raws, x);
    if (file !== undefined) record.file = file;
    if (model !== undefined) record.model = model;
    if (raw !== undefined) record.raw = raw;
    records.push(record);
    preceding = record.action;
  }

  const prompts = data.prompts.map(([seconds, s, interrupted]) => ({
    session_id: data.sessions[s],
    timestamp: fromSeconds(seconds),
    interrupted: interrupted === 1,
  }));

  return { records, prompts };
}
