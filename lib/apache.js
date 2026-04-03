'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const LOG_DIR = '/var/log/httpd';

// URL segments that carry a build version number
// Matches: /sched-2.5.6127/  /Diamond-2.5.6127/  /diamond/2.5.6127/
const URL_VERSION_RE = /(?:\/sched-|\/Diamond-|\/diamond\/)([\d]+\.[\d]+\.[\d]+[\w.-]*)\//;

// Apache combined log: 10.0.0.1 - - [03/Apr/2026:09:33:42 -0400] "GET /path HTTP/1.1" 200 ...
// SSL request log:     [03/Apr/2026:09:33:42 -0400] 10.0.0.1 TLSv1.3 ... "GET /path ..." bytes
const DATE_RE = /\[(\d{2})\/(\w{3})\/(\d{4}):/;

const MONTHS = {
  Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06',
  Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12',
};

function parseLineDate(line) {
  const m = line.match(DATE_RE);
  if (!m) return null;
  return `${m[3]}-${MONTHS[m[2]] || '00'}-${m[1]}`;
}

/**
 * Return log files from LOG_DIR whose names start with one of the given prefixes
 * and whose mtime is within maxAgeDays (or they are the "current" log with no date suffix).
 */
function collectLogFiles(prefixes, maxAgeDays) {
  const cutoffMs = Date.now() - maxAgeDays * 86400_000;
  let entries;
  try { entries = fs.readdirSync(LOG_DIR); } catch (_) { return []; }

  const files = [];
  for (const entry of entries) {
    if (!prefixes.some(p => entry.startsWith(p))) continue;
    const fullPath = path.join(LOG_DIR, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size === 0) continue;
      // Always include the current (no-date-suffix) file; for rotated files check mtime
      const isCurrent = !/-\d{8}$/.test(entry);
      if (isCurrent || stat.mtimeMs >= cutoffMs) {
        files.push(fullPath);
      }
    } catch (_) {}
  }
  return files;
}

/**
 * Grep `files` for lines containing a versioned URL segment.
 * Returns Map<version, { hits: number, lastSeen: string|null }>
 */
function grepVersionHits(files) {
  if (files.length === 0) return new Map();

  // Use extended grep — match the three URL patterns that contain a version
  const pattern = '(/sched-|/Diamond-|/diamond/)\\d+\\.\\d+\\.';
  const r = spawnSync('grep', ['-hE', pattern, ...files], {
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 20 * 1024 * 1024, // 20 MB — sufficient for matched lines only
  });

  const result = new Map();
  if (!r.stdout) return result;

  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const m = line.match(URL_VERSION_RE);
    if (!m) continue;
    const version = m[1];
    const date    = parseLineDate(line);

    if (!result.has(version)) result.set(version, { hits: 0, lastSeen: null });
    const entry = result.get(version);
    entry.hits++;
    if (date && (!entry.lastSeen || date > entry.lastSeen)) entry.lastSeen = date;
  }

  return result;
}

/**
 * Scan Apache logs for versioned CGI/asset hits.
 *
 * @param {number} maxAgeDays  How many days back to look (0 = skip entirely)
 * @returns {Map<string, { hits: number, lastSeen: string|null }>}
 */
function scanApacheLogs(maxAgeDays = 30) {
  if (maxAgeDays === 0) return new Map();

  const logFiles = collectLogFiles(
    ['access_log', 'ssl_access_log', 'ssl_request_log'],
    maxAgeDays,
  );

  return grepVersionHits(logFiles);
}

module.exports = { scanApacheLogs };
