'use strict';

const chalk = require('chalk');
const { formatBytes, getLatestBaseVersion, versionCompare } = require('./builds');

// ─── helpers ────────────────────────────────────────────────────────────────

function groupByVersion(arr) {
  const map = {};
  for (const item of arr) {
    if (item.version) {
      map[item.version] = map[item.version] || [];
      map[item.version].push(item);
    }
  }
  return map;
}

function allUniqueVersions(libBuilds, wwwBuilds, dojoBuilds, pm2Procs, tmuxPanes, apacheHits) {
  const set = new Set([
    ...libBuilds.map(b => b.version),
    ...wwwBuilds.map(b => b.version),
    ...dojoBuilds.map(b => b.version),
    ...pm2Procs.filter(p => p.version).map(p => p.version),
    ...tmuxPanes.filter(t => t.version).map(t => t.version),
    ...apacheHits.keys(),
  ]);
  return [...set].sort((a, b) => versionCompare(b, a));
}

// ─── status ─────────────────────────────────────────────────────────────────

function printStatus(libBuilds, wwwBuilds, dojoBuilds, pm2Procs, tmuxPanes, apacheHits = new Map()) {
  const latestVersion = getLatestBaseVersion(libBuilds);
  const libMap        = new Map(libBuilds.map(b => [b.version, b]));
  const wwwMap        = new Map(wwwBuilds.map(b => [b.version, b]));
  const dojoByVer     = groupByVersion(dojoBuilds);
  const pm2ByVer      = groupByVersion(pm2Procs);
  const tmuxByVer     = groupByVersion(tmuxPanes);
  const hasApache     = apacheHits.size > 0;

  const versions   = allUniqueVersions(libBuilds, wwwBuilds, dojoBuilds, pm2Procs, tmuxPanes, apacheHits);
  const orphanPm2  = pm2Procs.filter(p => !p.version);
  const orphanTmux = tmuxPanes.filter(t => !t.version);

  console.log('\n' + chalk.bold('DIAMOND BUILD STATUS'));
  console.log('═'.repeat(78));
  console.log(`Latest base version : ${chalk.green.bold(latestVersion || 'unknown')}`);
  console.log(`Report time         : ${new Date().toLocaleString()}`);
  if (!hasApache) console.log(chalk.dim(`Apache log scan     : no hits found (or skipped — use --days N)`));
  console.log('');

  let unusedLibBytes  = 0;
  let unusedWwwBytes  = 0;
  let unusedDojoBytes = 0;
  let unusedCount     = 0;

  for (const version of versions) {
    const lib    = libMap.get(version);
    const www    = wwwMap.get(version);
    const dojos  = dojoByVer[version] || [];
    const procs  = pm2ByVer[version]  || [];
    const tmuxes = tmuxByVer[version] || [];
    const apache = apacheHits.get(version) || null;
    const active = procs.length > 0 || tmuxes.length > 0 || apache !== null;
    const isLatest = version === latestVersion;

    let label, versionColor;
    if (active && isLatest) {
      label        = chalk.green.bold('ACTIVE (latest)');
      versionColor = chalk.green.bold;
    } else if (active) {
      label        = chalk.yellow('ACTIVE');
      versionColor = chalk.yellow;
    } else {
      label        = chalk.red('UNUSED ← cleanup candidate');
      versionColor = chalk.red;
      unusedCount++;
      if (lib?.sizeBytes)  unusedLibBytes  += lib.sizeBytes;
      if (www?.sizeBytes)  unusedWwwBytes  += www.sizeBytes;
      for (const d of dojos) if (d.sizeBytes) unusedDojoBytes += d.sizeBytes;
    }

    const libStr  = lib  ? formatBytes(lib.sizeBytes)  : chalk.dim('—');
    const wwwStr  = www  ? formatBytes(www.sizeBytes)  : chalk.dim('—');
    const dojoStr = dojos.length > 0
      ? dojos.map(d => d.dirName).join(', ')
      : chalk.dim('—');

    console.log(
      versionColor(version.padEnd(26)) +
      `lib: ${libStr.padEnd(7)}  www: ${wwwStr.padEnd(7)}  ${label}`
    );
    if (dojos.length > 0) {
      for (const d of dojos) {
        console.log(`  ${chalk.dim('dojo:')} ${d.dirName}  ${chalk.dim(formatBytes(d.sizeBytes))}`);
      }
    }

    for (const p of procs) {
      const dot = p.status === 'online' ? chalk.green('●') : chalk.red('○');
      const ns  = p.namespace ? chalk.dim(` [${p.namespace}]`) : '';
      console.log(`  ${dot} ${p.name}${ns}  ${chalk.dim(p.status)}`);
    }

    for (const t of tmuxes) {
      console.log(`  ${chalk.blue('▪')} tmux: ${t.session}  ${chalk.dim(t.panePath)}`);
    }

    if (apache) {
      const ago = apache.lastSeen ? ` — last hit ${apache.lastSeen}` : '';
      console.log(`  ${chalk.cyan('⬡')} apache: ${apache.hits.toLocaleString()} hits${ago}`);
    }
  }

  // Processes not tied to a versioned build dir
  if (orphanPm2.length > 0) {
    console.log('\n' + chalk.dim('─── pm2 processes not in a versioned build dir ───'));
    for (const p of orphanPm2) {
      const dot = p.status === 'online' ? chalk.green('●') : chalk.red('○');
      console.log(`  ${dot} ${p.name}  ${chalk.dim(p.cwd)}`);
    }
  }

  if (orphanTmux.length > 0) {
    console.log('\n' + chalk.dim('─── tmux panes not in a versioned build dir ───'));
    for (const t of orphanTmux) {
      console.log(`  ${chalk.blue('▪')} ${t.session}  ${chalk.dim(t.panePath)}`);
    }
  }

  // Summary
  const activeVersions = versions.filter(v => {
    const procs  = pm2ByVer[v]  || [];
    const tmuxes = tmuxByVer[v] || [];
    return procs.length > 0 || tmuxes.length > 0 || apacheHits.has(v);
  });

  const totalReclaimable = unusedLibBytes + unusedWwwBytes + unusedDojoBytes;

  console.log('\n' + '═'.repeat(78));
  console.log(chalk.bold('SUMMARY'));
  console.log(`  Lib builds  (/var/lib/diamond):   ${libBuilds.length} total,  ${chalk.green(activeVersions.filter(v => libMap.has(v)).length)} active,  ${chalk.red(unusedCount)} unused`);
  console.log(`  Www builds  (/var/www/html):       ${wwwBuilds.length} total`);
  console.log(`  Dojo builds (/var/www/html):       ${dojoBuilds.length} total`);
  if (totalReclaimable) {
    if (unusedLibBytes)  console.log(`  Reclaimable (lib):  ${chalk.red.bold(formatBytes(unusedLibBytes))}`);
    if (unusedWwwBytes)  console.log(`  Reclaimable (www):  ${chalk.red.bold(formatBytes(unusedWwwBytes))}`);
    if (unusedDojoBytes) console.log(`  Reclaimable (dojo): ${chalk.red.bold(formatBytes(unusedDojoBytes))}`);
    console.log(`  Total reclaimable:  ${chalk.red.bold(formatBytes(totalReclaimable))}`);
  }

  // Migration candidates: online pm2 processes on builds older than latest
  const migrationCandidates = pm2Procs.filter(
    p => p.version && p.version !== latestVersion && p.status === 'online'
  );
  if (migrationCandidates.length > 0) {
    console.log('\n' + chalk.yellow.bold('MIGRATION CANDIDATES') + chalk.dim(' (active processes on older builds)'));
    const byVer = groupByVersion(migrationCandidates);
    for (const ver of Object.keys(byVer).sort((a, b) => versionCompare(b, a))) {
      console.log(`  ${chalk.yellow(ver)}:`);
      for (const p of byVer[ver]) {
        console.log(`    ${chalk.green('●')} ${p.name}  ${chalk.dim('[' + p.namespace + ']')}`);
      }
    }
    console.log(`\n  Latest build: ${chalk.green.bold(latestVersion)}`);
  }
}

// ─── cleanup ────────────────────────────────────────────────────────────────

function printCleanup(libBuilds, wwwBuilds, dojoBuilds, pm2Procs, tmuxPanes, apacheHits = new Map()) {
  const pm2ByVer  = groupByVersion(pm2Procs);
  const tmuxByVer = groupByVersion(tmuxPanes);

  const isUnused = version => {
    const procs  = pm2ByVer[version]  || [];
    const tmuxes = tmuxByVer[version] || [];
    return procs.length === 0 && tmuxes.length === 0 && !apacheHits.has(version);
  };

  const unusedLib  = libBuilds.filter(b => isUnused(b.version));
  const unusedWww  = wwwBuilds.filter(b => isUnused(b.version));
  const unusedDojo = dojoBuilds.filter(b => isUnused(b.version));

  // Versions with Apache hits but no processes (warn, don't auto-delete)
  const apacheOnlyVersions = [...apacheHits.keys()].filter(v => {
    const procs  = pm2ByVer[v]  || [];
    const tmuxes = tmuxByVer[v] || [];
    return procs.length === 0 && tmuxes.length === 0;
  });

  console.log('\n' + chalk.bold('CLEANUP CANDIDATES'));
  console.log('═'.repeat(60));

  if (unusedLib.length === 0 && unusedWww.length === 0 && unusedDojo.length === 0 && apacheOnlyVersions.length === 0) {
    console.log(chalk.green('  No unused builds found.'));
    return;
  }

  if (apacheOnlyVersions.length > 0) {
    console.log(chalk.yellow.bold('\n  ⚠ Apache-only (no pm2/tmux but has recent web hits):'));
    for (const ver of apacheOnlyVersions) {
      const info = apacheHits.get(ver);
      console.log(`    ${chalk.yellow(ver)}  — ${info.hits.toLocaleString()} hits, last ${info.lastSeen || 'unknown'}`);
    }
    console.log(chalk.dim('  (not included in cleanup list below — verify before deleting)'));
  }

  const versions = [...new Set([
    ...unusedLib.map(b => b.version),
    ...unusedWww.map(b => b.version),
    ...unusedDojo.map(b => b.version),
  ])].sort((a, b) => versionCompare(b, a));

  if (versions.length === 0) {
    console.log('');
    return;
  }

  let totalBytes = 0;

  for (const version of versions) {
    const lib   = unusedLib.find(b => b.version === version);
    const www   = unusedWww.find(b => b.version === version);
    const dojos = unusedDojo.filter(b => b.version === version);
    const size  = (lib?.sizeBytes || 0) + (www?.sizeBytes || 0) +
                  dojos.reduce((s, d) => s + (d.sizeBytes || 0), 0);
    totalBytes += size;

    console.log(`\n  ${chalk.red.bold(version)}  ${chalk.dim('(' + formatBytes(size) + ')')}`);
    if (lib)  console.log(`    ${chalk.dim('rm -rf')} ${lib.path}`);
    if (www)  console.log(`    ${chalk.dim('rm -rf')} ${www.path}`);
    for (const d of dojos) console.log(`    ${chalk.dim('rm -rf')} ${d.path}`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`  Total reclaimable: ${chalk.red.bold(formatBytes(totalBytes))}`);
  console.log(chalk.dim('\n  Run `diamond-clean prune` to delete interactively.'));
}

// ─── prune helpers ───────────────────────────────────────────────────────────

function getUnusedBuilds(libBuilds, wwwBuilds, dojoBuilds, pm2Procs, tmuxPanes, apacheHits = new Map()) {
  const pm2ByVer  = groupByVersion(pm2Procs);
  const tmuxByVer = groupByVersion(tmuxPanes);

  const isUnused = version => {
    const procs  = pm2ByVer[version]  || [];
    const tmuxes = tmuxByVer[version] || [];
    return procs.length === 0 && tmuxes.length === 0 && !apacheHits.has(version);
  };

  return {
    unusedLib:  libBuilds.filter(b => isUnused(b.version)),
    unusedWww:  wwwBuilds.filter(b => isUnused(b.version)),
    unusedDojo: dojoBuilds.filter(b => isUnused(b.version)),
  };
}

module.exports = { printStatus, printCleanup, getUnusedBuilds };
