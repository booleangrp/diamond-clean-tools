'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LIB_BASE = '/var/lib/diamond';

// Matches versioned subdirs like /var/lib/diamond/2.5.5406-medmove22/...
const VERSION_IN_PATH = /\/var\/lib\/diamond\/(\d+\.\d+\.\d+[\w.-]*)/;

function findPm2Binary() {
  const nvmNodeDir = path.join(LIB_BASE, 'nvm', 'versions', 'node');
  try {
    const nodeDirs = fs.readdirSync(nvmNodeDir).sort().reverse();
    for (const nodeDir of nodeDirs) {
      const candidate = path.join(nvmNodeDir, nodeDir, 'bin', 'pm2');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch (_) {}
  // Fallback: look in PATH
  try {
    const r = spawnSync('which', ['pm2'], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.trim();
  } catch (_) {}
  return null;
}

function extractVersionFromPath(str) {
  if (!str) return null;
  const m = str.match(VERSION_IN_PATH);
  return m ? m[1] : null;
}

/**
 * Returns array of pm2 process descriptors:
 * { name, namespace, status, version, cwd, exec, pid }
 */
function discoverPm2(pm2Binary) {
  if (!pm2Binary) return [];
  const r = spawnSync(pm2Binary, ['jlist'], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0 || !r.stdout) return [];

  let raw;
  try {
    raw = JSON.parse(r.stdout);
  } catch (_) {
    return [];
  }

  return raw
    .filter(p => p.name !== 'pm2-logrotate') // skip module
    .map(p => {
      const env = p.pm2_env || {};
      const cwd  = env.pm_cwd || '';
      const exec = env.pm_exec_path || '';
      const version = extractVersionFromPath(cwd) || extractVersionFromPath(exec);
      return {
        name:      p.name,
        namespace: env.namespace || '',
        status:    env.status || 'unknown',
        version,
        cwd,
        exec,
        pid: p.pid || 0,
      };
    });
}

/**
 * Returns array of tmux pane descriptors that reference a versioned build dir:
 * { session, pid, panePath, version }
 */
function discoverTmux() {
  const r = spawnSync('tmux', [
    'list-panes', '-a', '-F',
    '#{session_name}\t#{pane_pid}\t#{pane_current_path}',
  ], { encoding: 'utf8', timeout: 5000 });

  if (r.status !== 0 || !r.stdout.trim()) return [];

  const panes = [];
  for (const line of r.stdout.trim().split('\n')) {
    const [session, pid, panePath] = line.split('\t');
    // Also check /proc/<pid>/cmdline for processes inside the pane
    const version = extractVersionFromPath(panePath)
      || extractVersionFromPath(readProcCmdline(pid));
    panes.push({ session: session || '', pid: pid || '', panePath: panePath || '', version: version || null });
  }
  return panes;
}

function readProcCmdline(pid) {
  if (!pid) return '';
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch (_) {
    return '';
  }
}

/**
 * Aggregate: returns { pm2, tmux, versionsInUse }
 * versionsInUse is a Set<string> of all version strings referenced by running processes.
 */
function discoverAll(pm2Binary) {
  const pm2  = discoverPm2(pm2Binary);
  const tmux = discoverTmux();

  const versionsInUse = new Set();
  for (const p of pm2)  { if (p.version) versionsInUse.add(p.version); }
  for (const t of tmux) { if (t.version) versionsInUse.add(t.version); }

  return { pm2, tmux, versionsInUse };
}

module.exports = { findPm2Binary, discoverAll, extractVersionFromPath };
