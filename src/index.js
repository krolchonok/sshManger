#!/usr/bin/env node
'use strict';

if (process.env.NCURSES_NO_UTF8_ACS == null) {
  process.env.NCURSES_NO_UTF8_ACS = '1';
}

const { loadState, saveState, nowIso } = require('./state');
const { loadHostsFromConfig } = require('./sshConfig');
const { runTui } = require('./tui');
const { runInteractiveSsh, isProcessAlive } = require('./ssh');

function syncTunnelStatus(state) {
  let changed = false;

  for (const tunnel of state.tunnels) {
    if (!tunnel.pid) {
      continue;
    }
    if (!isProcessAlive(tunnel.pid)) {
      tunnel.pid = null;
      tunnel.updatedAt = nowIso();
      changed = true;
    }
  }

  if (changed) {
    saveState(state);
  }
}

async function main() {
  const state = loadState();

  while (true) {
    syncTunnelStatus(state);
    const hosts = loadHostsFromConfig();

    const action = await runTui({
      state,
      hosts,
      saveState
    });

    if (!action || action.type === 'quit') {
      break;
    }

    if (action.type === 'reload') {
      continue;
    }

    if (action.type === 'connect' && action.host) {
      // At this point TUI is closed and we can run interactive ssh in the same terminal.
      const result = await runInteractiveSsh(action.host);
      const code = typeof result.code === 'number' ? result.code : 0;
      // Keep output minimal; TUI restarts on next loop iteration.
      process.stdout.write(`\nSSH session finished (code: ${code})\n`);
      continue;
    }
  }
}

process.on('unhandledRejection', (error) => {
  process.stderr.write(`Unhandled rejection: ${error && error.stack ? error.stack : error}\n`);
});

process.on('uncaughtException', (error) => {
  process.stderr.write(`Uncaught exception: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
