// Incremental scanner over Claude Code's transcript directory: the I/O shell around the pure
// transcript parser. It is run by the mod as a child process (bin/praxis-history.mjs), because a
// mod can read at most 4 MiB per file and a long session's transcript runs to 100 MB or more.
//
// Transcripts are append-only, so the scanner remembers how many bytes of each file it has
// parsed and, on the next run, reads only what was appended. A full first scan of a heavy
// history takes a second or two; every scan after that takes milliseconds, which is what lets
// the mod refresh the profile after each turn.

import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseTranscriptLine } from "./transcript.mjs";
import { buildHistory, encodeHistory } from "./history.mjs";

const CACHE_VERSION = 1;
const NEWLINE = 0x0a;

/**
 * Default locations, honoring `CLAUDE_CONFIG_DIR` the way Claude Code does.
 * @returns {{ projectsDir: string, dataDir: string }}
 */
export function defaultDirs() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return { projectsDir: join(configDir, "projects"), dataDir: join(configDir, "praxis") };
}

/**
 * Parse a file from byte `start` to its last complete line. Returns the events and the offset
 * just past the last newline, so a line still being written is picked up whole next time.
 * @param {string} path
 * @param {number} start
 * @returns {Promise<{ events: object[], offset: number }>}
 */
async function parseFrom(path, start) {
  const events = [];
  let offset = start;
  let carry = Buffer.alloc(0);

  for await (const chunk of createReadStream(path, { start })) {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let lineStart = 0;
    let nl;
    while ((nl = buf.indexOf(NEWLINE, lineStart)) !== -1) {
      const line = buf.toString("utf8", lineStart, nl);
      if (line) events.push(...parseTranscriptLine(line));
      lineStart = nl + 1;
    }
    offset += lineStart;
    carry = buf.subarray(lineStart);
  }
  return { events, offset };
}

/**
 * Read the cache, or start a fresh one if it is missing, unreadable, or from another version.
 * @param {string} path
 */
async function loadCache(path) {
  try {
    const cache = JSON.parse(await readFile(path, "utf8"));
    if (cache?.v === CACHE_VERSION && cache.files) return cache;
  } catch {
    /* first run, or a damaged cache: rebuild it */
  }
  return { v: CACHE_VERSION, files: {} };
}

/** Write via a temporary file and rename, so a reader never sees a half-written file. */
async function writeAtomic(path, text) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text);
  await rename(temp, path);
}

/**
 * List the top-level `.jsonl` transcripts, one directory per project. Subagent transcripts live
 * in nested folders and are skipped: the profile is about the main conversation.
 * @param {string} projectsDir
 * @returns {Promise<string[]>} paths relative to projectsDir
 */
async function listTranscripts(projectsDir) {
  let projects;
  try {
    projects = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return []; // no history yet
  }
  const found = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const entries = await readdir(join(projectsDir, project.name), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl"))
        found.push(join(project.name, entry.name));
    }
  }
  return found.sort();
}

/**
 * Scan the transcript directory, update the cache, and write the encoded history.
 * @param {{ projectsDir?: string, dataDir?: string }} [options]
 * @returns {Promise<{ out: string, files: number, reparsed: number, sessions: number,
 *   toolCalls: number, ms: number }>}
 */
export async function scanHistory(options = {}) {
  const started = Date.now();
  const dirs = { ...defaultDirs(), ...options };
  await mkdir(dirs.dataDir, { recursive: true });

  const cachePath = join(dirs.dataDir, "scan-cache.json");
  const outPath = join(dirs.dataDir, "history.json");
  const cache = await loadCache(cachePath);
  const files = await listTranscripts(dirs.projectsDir);

  const next = { v: CACHE_VERSION, files: {} };
  const events = [];
  let reparsed = 0;

  for (const rel of files) {
    const path = join(dirs.projectsDir, rel);
    const info = await stat(path);
    const seen = cache.files[rel];
    let entry;

    if (seen && seen.size === info.size && seen.mtimeMs === info.mtimeMs) {
      entry = seen;
    } else if (seen && info.size >= seen.offset) {
      const tail = await parseFrom(path, seen.offset);
      entry = { ...tail, events: seen.events.concat(tail.events) };
      reparsed += 1;
    } else {
      entry = await parseFrom(path, 0); // new file, or one that shrank (rewritten)
      reparsed += 1;
    }

    next.files[rel] = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      offset: entry.offset,
      events: entry.events,
    };
    for (const e of entry.events) events.push(e);
  }

  const history = buildHistory(events);
  await writeAtomic(outPath, JSON.stringify(encodeHistory(history)));
  await writeAtomic(cachePath, JSON.stringify(next));

  return {
    out: outPath,
    files: files.length,
    reparsed,
    sessions: new Set(history.records.map((r) => r.session_id)).size,
    toolCalls: history.records.length,
    ms: Date.now() - started,
  };
}
