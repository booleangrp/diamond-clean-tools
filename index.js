#!/usr/bin/env node
'use strict';

const { Command }  = require('commander');
const readline     = require('readline');
const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');

const { findPm2Binary, discoverAll }                     = require('./lib/discover');
const { scanLibBuilds, scanWwwBuilds, scanDojoBuilds, scanSchedBuilds, formatBytes } = require('./lib/builds');
const { printStatus, printCleanup, getUnusedBuilds }     = require('./lib/display');
const { scanApacheLogs }                                 = require('./lib/apache');

// ─── helpers ─────────────────────────────────────────────────────────────────

function checkRoot() {
  if (process.getuid && process.getuid() !== 0) {
    console.warn('Warning: not running as root — pm2 and tmux data may be incomplete.\n');
  }
}

function gatherData({ withSizes = true, apacheDays = 30 } = {}) {
  const pm2Binary = findPm2Binary();
  if (!pm2Binary) {
    console.warn('Warning: pm2 binary not found under /var/lib/diamond/nvm.\n');
  }

  if (withSizes) process.stderr.write('Scanning build directories...\r');

  const { pm2, tmux } = discoverAll(pm2Binary);
  const libBuilds     = scanLibBuilds(withSizes);
  const wwwBuilds     = scanWwwBuilds(withSizes);
  const dojoBuilds    = scanDojoBuilds(withSizes);
  const schedBuilds   = scanSchedBuilds(withSizes);

  if (withSizes) process.stderr.write('                              \r');

  if (apacheDays > 0) process.stderr.write('Scanning Apache logs...       \r');
  const apacheHits = scanApacheLogs(apacheDays);
  if (apacheDays > 0) process.stderr.write('                              \r');

  return { pm2, tmux, libBuilds, wwwBuilds, dojoBuilds, schedBuilds, apacheHits };
}

function prompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name('diamond-clean')
  .description('Diamond build cleanup and migration analysis tool')
  .version('1.0.0');

// ── status (default) ─────────────────────────────────────────────────────────

program
  .command('status', { isDefault: true })
  .description('Show all builds and their usage status (default)')
  .option('--no-sizes',    'Skip disk usage calculation (faster)')
  .option('--days <n>',    'Apache log look-back window in days (0 = skip)', '30')
  .action(opts => {
    checkRoot();
    const apacheDays = parseInt(opts.days, 10) || 0;
    const { pm2, tmux, libBuilds, wwwBuilds, dojoBuilds, schedBuilds, apacheHits } =
      gatherData({ withSizes: opts.sizes !== false, apacheDays });
    printStatus(libBuilds, wwwBuilds, dojoBuilds, schedBuilds, pm2, tmux, apacheHits);
  });

// ── cleanup ──────────────────────────────────────────────────────────────────

program
  .command('cleanup')
  .description('List build directories with no running processes or recent web hits')
  .option('--no-sizes',    'Skip disk usage calculation (faster)')
  .option('--days <n>',    'Apache log look-back window in days (0 = skip)', '30')
  .action(opts => {
    checkRoot();
    const apacheDays = parseInt(opts.days, 10) || 0;
    const { pm2, tmux, libBuilds, wwwBuilds, dojoBuilds, schedBuilds, apacheHits } =
      gatherData({ withSizes: opts.sizes !== false, apacheDays });
    printCleanup(libBuilds, wwwBuilds, dojoBuilds, schedBuilds, pm2, tmux, apacheHits);
  });

// ── prune ────────────────────────────────────────────────────────────────────

program
  .command('prune')
  .description('Delete (or move) unused build directories')
  .option('--dry-run',          'Show what would happen without doing anything')
  .option('-y, --yes',          'Skip confirmation prompt')
  .option('--days <n>',         'Apache log look-back window in days (0 = skip)', '30')
  .option('--move-to <dir>',    'Move directories to <dir> instead of deleting them')
  .action(async opts => {
    checkRoot();
    const apacheDays = parseInt(opts.days, 10) || 0;
    const moveTo     = opts.moveTo || null;

    // Validate --move-to destination up front
    if (moveTo) {
      if (!fs.existsSync(moveTo)) {
        console.error(`Error: --move-to destination does not exist: ${moveTo}`);
        process.exit(1);
      }
      if (!fs.statSync(moveTo).isDirectory()) {
        console.error(`Error: --move-to destination is not a directory: ${moveTo}`);
        process.exit(1);
      }
    }

    const { pm2, tmux, libBuilds, wwwBuilds, dojoBuilds, schedBuilds, apacheHits } =
      gatherData({ withSizes: true, apacheDays });
    const { unusedLib, unusedWww, unusedDojo, unusedSched } =
      getUnusedBuilds(libBuilds, wwwBuilds, dojoBuilds, schedBuilds, pm2, tmux, apacheHits);

    const targets = [];
    const versions = [...new Set([
      ...unusedLib.map(b => b.version),
      ...unusedWww.map(b => b.version),
      ...unusedDojo.map(b => b.version),
      ...unusedSched.map(b => b.version),
    ])];

    for (const version of versions) {
      const lib    = unusedLib.find(b => b.version === version);
      const www    = unusedWww.find(b => b.version === version);
      const dojos  = unusedDojo.filter(b => b.version === version);
      const scheds = unusedSched.filter(b => b.version === version);
      if (lib)  targets.push({ path: lib.path,  sizeBytes: lib.sizeBytes });
      if (www)  targets.push({ path: www.path,  sizeBytes: www.sizeBytes });
      for (const d of dojos)  targets.push({ path: d.path, sizeBytes: d.sizeBytes });
      for (const s of scheds) targets.push({ path: s.path, sizeBytes: s.sizeBytes });
    }

    if (targets.length === 0) {
      console.log('No unused builds found.');
      return;
    }

    const totalBytes = targets.reduce((s, t) => s + (t.sizeBytes || 0), 0);
    const action     = moveTo ? `Move to ${moveTo}` : 'Delete';
    console.log(`\nBuilds to ${moveTo ? 'move' : 'delete'}:`);
    for (const t of targets) {
      const dest = moveTo ? ` → ${path.join(moveTo, path.basename(t.path))}` : '';
      console.log(`  ${t.path}  (${formatBytes(t.sizeBytes)})${dest}`);
    }
    console.log(`\nTotal: ${formatBytes(totalBytes)}\n`);

    if (opts.dryRun) {
      console.log(`Dry run — nothing ${moveTo ? 'moved' : 'deleted'}.`);
      return;
    }

    if (!opts.yes) {
      const answer = await prompt(`${action} all of the above? [y/N] `);
      if (answer !== 'y' && answer !== 'yes') {
        console.log('Aborted.');
        return;
      }
    }

    let done = 0;
    for (const t of targets) {
      if (moveTo) {
        const dest = path.join(moveTo, path.basename(t.path));
        process.stdout.write(`  Moving ${t.path} → ${dest} ...`);
        try {
          execSync(`mv ${JSON.stringify(t.path)} ${JSON.stringify(dest)}`);
          process.stdout.write(' done\n');
          done++;
        } catch (e) {
          process.stdout.write(` FAILED: ${e.message}\n`);
        }
      } else {
        process.stdout.write(`  Deleting ${t.path} ...`);
        try {
          execSync(`rm -rf ${JSON.stringify(t.path)}`);
          process.stdout.write(' done\n');
          done++;
        } catch (e) {
          process.stdout.write(` FAILED: ${e.message}\n`);
        }
      }
    }

    console.log(`\n${moveTo ? 'Moved' : 'Deleted'} ${done} of ${targets.length} directories.`);
  });

program.parse(process.argv);
