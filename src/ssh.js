'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ASKPASS_DIR, LOG_DIR, ensureDirs } = require('./paths');
const { nowIso } = require('./state');

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      return true;
    }
    return false;
  }
}

function runInteractiveSsh(host) {
  return new Promise((resolve) => {
    const child = spawn('ssh', [host], {
      stdio: 'inherit'
    });

    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });

    child.on('error', (error) => {
      resolve({ code: 255, signal: null, error });
    });
  });
}

function createAskpassScript(password) {
  ensureDirs();
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const isWin = process.platform === 'win32';
  const fileName = isWin ? `askpass-${id}.cmd` : `askpass-${id}.sh`;
  const filePath = path.join(ASKPASS_DIR, fileName);

  if (isWin) {
    const script = '@echo off\r\nsetlocal\r\nif defined SSHHELPER_PASSWORD (echo %SSHHELPER_PASSWORD%)\r\n';
    fs.writeFileSync(filePath, script, 'utf8');
  } else {
    const script = '#!/bin/sh\nprintf "%s\\n" "$SSHHELPER_PASSWORD"\n';
    fs.writeFileSync(filePath, script, 'utf8');
    fs.chmodSync(filePath, 0o700);
  }

  return {
    filePath,
    env: {
      SSH_ASKPASS: filePath,
      SSH_ASKPASS_REQUIRE: 'force',
      SSHHELPER_PASSWORD: password,
      DISPLAY: process.env.DISPLAY || 'sshhelper:0'
    }
  };
}

function cleanupAskpassLater(filePath) {
  setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      // ignore cleanup errors
    }
  }, 15_000);
}

function buildTunnelSpec(type, config) {
  if (type === 'L') {
    return `${config.localPort}:${config.targetHost}:${config.targetPort}`;
  }
  if (type === 'R') {
    return `${config.remotePort}:${config.targetHost}:${config.targetPort}`;
  }
  if (type === 'D') {
    return String(config.localPort);
  }
  throw new Error(`Unsupported tunnel type: ${type}`);
}

function buildTunnelArgs(tunnel) {
  const args = ['-N'];

  if (tunnel.type === 'L') {
    args.push('-L', tunnel.spec);
  } else if (tunnel.type === 'R') {
    args.push('-R', tunnel.spec);
  } else if (tunnel.type === 'D') {
    args.push('-D', tunnel.spec);
  } else {
    throw new Error(`Unsupported tunnel type: ${tunnel.type}`);
  }

  args.push(tunnel.host);
  return args;
}

function buildLogPath(tunnelId) {
  ensureDirs();
  const safeId = tunnelId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(LOG_DIR, `tunnel-${safeId}.log`);
}

function startTunnel(tunnel, password) {
  return new Promise((resolve, reject) => {
    let outFd = null;
    let settled = false;
    const finishResolve = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    try {
      ensureDirs();
      const logFile = tunnel.logFile || buildLogPath(tunnel.id);
      outFd = fs.openSync(logFile, 'a');
      const args = buildTunnelArgs(tunnel);
      const env = { ...process.env };

      let askpassPath = '';
      if (tunnel.auth === 'password') {
        if (!password) {
          throw new Error('Password is required for this tunnel');
        }

        const askpass = createAskpassScript(password);
        askpassPath = askpass.filePath;
        Object.assign(env, askpass.env);
      }

      const child = spawn('ssh', args, {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', outFd, outFd],
        env
      });

      child.unref();
      fs.closeSync(outFd);
      outFd = null;

      if (askpassPath) {
        cleanupAskpassLater(askpassPath);
      }

      child.once('error', (error) => {
        finishReject(error);
      });

      setTimeout(() => {
        if (!child.pid) {
          finishReject(new Error('Failed to spawn ssh tunnel process'));
          return;
        }
        if (!isProcessAlive(child.pid)) {
          finishReject(new Error('ssh tunnel process exited early. Check log file for details.'));
          return;
        }

        finishResolve({
          pid: child.pid,
          logFile,
          updatedAt: nowIso()
        });
      }, 300);
    } catch (error) {
      if (outFd !== null) {
        try {
          fs.closeSync(outFd);
        } catch (closeError) {
          // ignore close errors on failure path
        }
      }
      finishReject(error);
    }
  });
}

function stopTunnel(pid) {
  if (!Number.isInteger(pid)) {
    throw new Error('Invalid PID');
  }

  try {
    process.kill(pid);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

module.exports = {
  runInteractiveSsh,
  startTunnel,
  stopTunnel,
  isProcessAlive,
  buildTunnelSpec
};
