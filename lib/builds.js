'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LIB_BASE = '/var/lib/diamond';
const WWW_BASE = '/var/www/html';

const VERSION_DIR_RE  = /^\d+\.\d+\.\d+/;               // lib dirs:  2.5.5326, 2.5.5406-medmove22
const WWW_DIR_RE      = /^Diamond-(\d+\.\d+\.\d+)/;      // www dirs:  Diamond-2.5.5326
const DOJO_DIR_RE     = /^dojo-(\d+\.\d+\.\d+[\w.-]*)-\d+\.\d+/; // dojo dirs: dojo-2.5.5326-1.10.7

/**
 * Compare two version strings numerically by their x.y.z base.
 * Variants (with suffix) are sorted after their base version.
 */
function versionCompare(a, b) {
  const parseBase = v => v.split('-')[0].split('.').map(Number);
  const [aNums, bNums] = [parseBase(a), parseBase(b)];
  for (let i = 0; i < Math.max(aNums.length, bNums.length); i++) {
    const diff = (aNums[i] || 0) - (bNums[i] || 0);
    if (diff !== 0) return diff;
  }
  // Equal numeric base: plain version before suffixed variants
  const aVar = a.includes('-') ? 1 : 0;
  const bVar = b.includes('-') ? 1 : 0;
  return aVar - bVar;
}

function getDiskSizeBytes(dirPath) {
  const r = spawnSync('du', ['-sb', dirPath], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0 || !r.stdout) return null;
  const bytes = parseInt(r.stdout.split('\t')[0], 10);
  return isNaN(bytes) ? null : bytes;
}

function formatBytes(bytes) {
  if (bytes == null) return '?';
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + 'G';
  if (bytes >= 1048576)    return Math.round(bytes / 1048576)     + 'M';
  if (bytes >= 1024)       return Math.round(bytes / 1024)        + 'K';
  return bytes + 'B';
}

/**
 * Scan /var/lib/diamond for versioned build dirs.
 * Returns array sorted newest→oldest:
 * [{ version, path, sizeBytes }]
 */
function scanLibBuilds(withSizes = true) {
  let entries;
  try {
    entries = fs.readdirSync(LIB_BASE);
  } catch (_) {
    return [];
  }

  return entries
    .filter(d => VERSION_DIR_RE.test(d))
    .map(d => {
      const fullPath = path.join(LIB_BASE, d);
      return {
        version:   d,
        path:      fullPath,
        sizeBytes: withSizes ? getDiskSizeBytes(fullPath) : null,
      };
    })
    .sort((a, b) => versionCompare(b.version, a.version));
}

/**
 * Scan /var/www/html for Diamond-* build dirs.
 * Returns array sorted newest→oldest:
 * [{ version, dirName, path, sizeBytes }]
 */
function scanWwwBuilds(withSizes = true) {
  let entries;
  try {
    entries = fs.readdirSync(WWW_BASE);
  } catch (_) {
    return [];
  }

  return entries
    .filter(d => WWW_DIR_RE.test(d))
    .map(d => {
      const m = d.match(WWW_DIR_RE);
      const fullPath = path.join(WWW_BASE, d);
      return {
        version:   d.replace(/^Diamond-/, ''), // e.g. "2.5.5326"
        dirName:   d,
        path:      fullPath,
        sizeBytes: withSizes ? getDiskSizeBytes(fullPath) : null,
      };
    })
    .sort((a, b) => versionCompare(b.version, a.version));
}

/**
 * Scan /var/www/html for dojo-{BUILD_VERSION}-{DOJO_VERSION} dirs.
 * Ignores non-versioned dirs like dojo-QA-* or dojo-phoroszo-*.
 * Returns array sorted newest→oldest:
 * [{ version, dirName, path, sizeBytes }]
 */
function scanDojoBuilds(withSizes = true) {
  let entries;
  try {
    entries = fs.readdirSync(WWW_BASE);
  } catch (_) {
    return [];
  }

  return entries
    .filter(d => DOJO_DIR_RE.test(d))
    .map(d => {
      const m = d.match(DOJO_DIR_RE);
      const fullPath = path.join(WWW_BASE, d);
      return {
        version:   m[1],   // e.g. "2.5.5326"
        dirName:   d,
        path:      fullPath,
        sizeBytes: withSizes ? getDiskSizeBytes(fullPath) : null,
      };
    })
    .sort((a, b) => versionCompare(b.version, a.version));
}

/**
 * The "latest" base version: highest x.y.z among non-variant lib builds.
 */
function getLatestBaseVersion(libBuilds) {
  const base = libBuilds.filter(b => !b.version.includes('-'));
  return base.length ? base[0].version : null; // already sorted desc
}

module.exports = { scanLibBuilds, scanWwwBuilds, scanDojoBuilds, versionCompare, formatBytes, getLatestBaseVersion };
