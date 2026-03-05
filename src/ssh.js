'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ASKPASS_DIR, LOG_DIR, ensureDirs } = require('./paths');
const { nowIso } = require('./state');

const DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES = 200 * 1024;
const DEFAULT_PROBE_OUTPUT_LIMIT_BYTES = 16 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 12_000;

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

function appendLimitedChunk(chunks, totalSize, chunk, freeBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''), 'utf8');
  if (buffer.length === 0) {
    return { totalSize, addedBytes: 0, truncated: false };
  }
  if (freeBytes <= 0) {
    return { totalSize, addedBytes: 0, truncated: true };
  }

  if (buffer.length <= freeBytes) {
    chunks.push(buffer);
    return { totalSize: totalSize + buffer.length, addedBytes: buffer.length, truncated: false };
  }

  chunks.push(buffer.subarray(0, freeBytes));
  return { totalSize: totalSize + freeBytes, addedBytes: freeBytes, truncated: true };
}

function runSshCommand(host, command, options = {}) {
  return new Promise((resolve) => {
    const targetHost = String(host || '').trim();
    const remoteCommand = String(command || '').trim();
    let outputLimitBytes = DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES;
    let password = '';

    if (typeof options === 'number' && Number.isFinite(options) && options > 0) {
      outputLimitBytes = Math.floor(options);
    } else if (options && typeof options === 'object') {
      if (Number.isFinite(options.outputLimitBytes) && options.outputLimitBytes > 0) {
        outputLimitBytes = Math.floor(options.outputLimitBytes);
      }
      if (typeof options.password === 'string' && options.password.length > 0) {
        password = options.password;
      }
    }

    if (!targetHost) {
      resolve({
        code: null,
        signal: null,
        error: 'Host is required',
        truncated: false,
        stdout: '',
        stderr: ''
      });
      return;
    }

    if (!remoteCommand) {
      resolve({
        code: null,
        signal: null,
        error: 'Command is required',
        truncated: false,
        stdout: '',
        stderr: ''
      });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let totalCaptured = 0;
    let truncated = false;
    let done = false;

    const finish = (result) => {
      if (done) {
        return;
      }
      done = true;
      resolve({
        code: result.code,
        signal: result.signal,
        error: result.error,
        truncated,
        stdout: Buffer.concat(stdoutChunks, stdoutSize).toString('utf8'),
        stderr: Buffer.concat(stderrChunks, stderrSize).toString('utf8')
      });
    };

    let child = null;
    let askpassPath = '';
    try {
      const env = { ...process.env };
      const args = [];
      if (password) {
        const askpass = createAskpassScript(password);
        askpassPath = askpass.filePath;
        Object.assign(env, askpass.env);
        args.push(
          '-o',
          'BatchMode=no',
          '-o',
          'PreferredAuthentications=password,keyboard-interactive',
          '-o',
          'PubkeyAuthentication=no'
        );
      } else {
        args.push('-o', 'BatchMode=yes');
      }
      args.push(targetHost, remoteCommand);

      child = spawn('ssh', args, {
        cwd: process.cwd(),
        env
      });
      if (askpassPath) {
        cleanupAskpassLater(askpassPath);
      }
    } catch (error) {
      if (askpassPath) {
        cleanupAskpassLater(askpassPath);
      }
      finish({ code: null, signal: null, error: error.message });
      return;
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const appended = appendLimitedChunk(
          stdoutChunks,
          stdoutSize,
          chunk,
          outputLimitBytes - totalCaptured
        );
        stdoutSize = appended.totalSize;
        totalCaptured += appended.addedBytes;
        truncated = truncated || appended.truncated;
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const appended = appendLimitedChunk(
          stderrChunks,
          stderrSize,
          chunk,
          outputLimitBytes - totalCaptured
        );
        stderrSize = appended.totalSize;
        totalCaptured += appended.addedBytes;
        truncated = truncated || appended.truncated;
      });
    }

    child.on('error', (error) => {
      finish({ code: null, signal: null, error: error.message });
    });

    child.on('close', (code, signal) => {
      finish({
        code: typeof code === 'number' ? code : null,
        signal: signal || null,
        error: null
      });
    });
  });
}

function runSshCopyId(host, options = {}) {
  return new Promise((resolve) => {
    const targetHost = String(host || '').trim();
    let outputLimitBytes = DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES;
    let password = '';
    let publicKeyPath = '';

    if (typeof options === 'number' && Number.isFinite(options) && options > 0) {
      outputLimitBytes = Math.floor(options);
    } else if (options && typeof options === 'object') {
      if (Number.isFinite(options.outputLimitBytes) && options.outputLimitBytes > 0) {
        outputLimitBytes = Math.floor(options.outputLimitBytes);
      }
      if (typeof options.password === 'string' && options.password.length > 0) {
        password = options.password;
      }
      if (typeof options.publicKeyPath === 'string' && options.publicKeyPath.trim().length > 0) {
        publicKeyPath = options.publicKeyPath.trim();
      }
    }

    if (!targetHost) {
      resolve({
        code: null,
        signal: null,
        error: 'Host is required',
        truncated: false,
        stdout: '',
        stderr: ''
      });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let totalCaptured = 0;
    let truncated = false;
    let done = false;

    const finish = (result) => {
      if (done) {
        return;
      }
      done = true;
      resolve({
        code: result.code,
        signal: result.signal,
        error: result.error,
        truncated,
        stdout: Buffer.concat(stdoutChunks, stdoutSize).toString('utf8'),
        stderr: Buffer.concat(stderrChunks, stderrSize).toString('utf8')
      });
    };

    let child = null;
    let askpassPath = '';
    try {
      const env = { ...process.env };
      const args = [];
      if (publicKeyPath) {
        args.push('-i', publicKeyPath);
      }
      if (password) {
        const askpass = createAskpassScript(password);
        askpassPath = askpass.filePath;
        Object.assign(env, askpass.env);
        args.push(
          '-o',
          'BatchMode=no',
          '-o',
          'PreferredAuthentications=password,keyboard-interactive',
          '-o',
          'PubkeyAuthentication=no'
        );
      } else {
        args.push('-o', 'BatchMode=yes');
      }
      args.push(targetHost);

      child = spawn('ssh-copy-id', args, {
        cwd: process.cwd(),
        env
      });
      if (askpassPath) {
        cleanupAskpassLater(askpassPath);
      }
    } catch (error) {
      if (askpassPath) {
        cleanupAskpassLater(askpassPath);
      }
      finish({ code: null, signal: null, error: error.message });
      return;
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const appended = appendLimitedChunk(
          stdoutChunks,
          stdoutSize,
          chunk,
          outputLimitBytes - totalCaptured
        );
        stdoutSize = appended.totalSize;
        totalCaptured += appended.addedBytes;
        truncated = truncated || appended.truncated;
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const appended = appendLimitedChunk(
          stderrChunks,
          stderrSize,
          chunk,
          outputLimitBytes - totalCaptured
        );
        stderrSize = appended.totalSize;
        totalCaptured += appended.addedBytes;
        truncated = truncated || appended.truncated;
      });
    }

    child.on('error', (error) => {
      finish({ code: null, signal: null, error: error.message });
    });

    child.on('close', (code, signal) => {
      finish({
        code: typeof code === 'number' ? code : null,
        signal: signal || null,
        error: null
      });
    });
  });
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

function appendTunnelLog(tunnel, message) {
  try {
    const tunnelId = tunnel && tunnel.id ? String(tunnel.id) : `unknown-${Date.now()}`;
    const logFile = (tunnel && tunnel.logFile) ? tunnel.logFile : buildLogPath(tunnelId);
    const text = String(message || '').trim();
    fs.appendFileSync(logFile, `[${nowIso()}] ${text}\n`, 'utf8');
    return logFile;
  } catch (error) {
    return '';
  }
}

function isSshAuthFailureText(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower) {
    return false;
  }
  return (
    lower.includes('permission denied') ||
    lower.includes('authentication failed') ||
    lower.includes('too many authentication failures') ||
    lower.includes('no supported authentication methods available') ||
    lower.includes('publickey') ||
    lower.includes('keyboard-interactive')
  );
}

function probeSshKeyAuth(host) {
  return new Promise((resolve) => {
    const targetHost = String(host || '').trim();
    if (!targetHost) {
      resolve({
        ok: false,
        authFailed: false,
        error: 'Host is required',
        stdout: '',
        stderr: ''
      });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let totalCaptured = 0;
    let done = false;

    const finish = (result) => {
      if (done) {
        return;
      }
      done = true;
      const stdout = Buffer.concat(stdoutChunks, stdoutSize).toString('utf8');
      const stderr = Buffer.concat(stderrChunks, stderrSize).toString('utf8');
      resolve({
        ok: Boolean(result.ok),
        authFailed: Boolean(result.authFailed),
        code: typeof result.code === 'number' ? result.code : null,
        signal: result.signal || null,
        error: result.error || '',
        stdout,
        stderr
      });
    };

    const args = [
      '-n',
      '-o',
      'BatchMode=yes',
      '-o',
      'NumberOfPasswordPrompts=0',
      '-o',
      'PreferredAuthentications=publickey',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no',
      '-o',
      'ConnectTimeout=8',
      targetHost,
      'exit'
    ];

    let child = null;
    let probeTimeout = null;
    try {
      child = spawn('ssh', args, {
        cwd: process.cwd(),
        env: { ...process.env }
      });
    } catch (error) {
      finish({
        ok: false,
        authFailed: false,
        error: error.message
      });
      return;
    }

    probeTimeout = setTimeout(() => {
      finish({
        ok: false,
        authFailed: false,
        error: `SSH key auth probe timed out after ${DEFAULT_PROBE_TIMEOUT_MS}ms`
      });
      try {
        child.kill();
      } catch (error) {
        // ignore kill errors for timeout path
      }
    }, DEFAULT_PROBE_TIMEOUT_MS);

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const appended = appendLimitedChunk(
          stdoutChunks,
          stdoutSize,
          chunk,
          DEFAULT_PROBE_OUTPUT_LIMIT_BYTES - totalCaptured
        );
        stdoutSize = appended.totalSize;
        totalCaptured += appended.addedBytes;
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const appended = appendLimitedChunk(
          stderrChunks,
          stderrSize,
          chunk,
          DEFAULT_PROBE_OUTPUT_LIMIT_BYTES - totalCaptured
        );
        stderrSize = appended.totalSize;
        totalCaptured += appended.addedBytes;
      });
    }

    child.on('error', (error) => {
      if (probeTimeout) {
        clearTimeout(probeTimeout);
      }
      finish({
        ok: false,
        authFailed: false,
        error: error.message
      });
    });

    child.on('close', (code, signal) => {
      if (probeTimeout) {
        clearTimeout(probeTimeout);
      }
      const stdout = Buffer.concat(stdoutChunks, stdoutSize).toString('utf8');
      const stderr = Buffer.concat(stderrChunks, stderrSize).toString('utf8');
      if (code === 0) {
        finish({
          ok: true,
          authFailed: false,
          code,
          signal
        });
        return;
      }
      finish({
        ok: false,
        authFailed: isSshAuthFailureText(`${stderr}\n${stdout}`),
        code: typeof code === 'number' ? code : null,
        signal: signal || null,
        error: ''
      });
    });
  });
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
      if (password) {
        const askpass = createAskpassScript(password);
        askpassPath = askpass.filePath;
        Object.assign(env, askpass.env);
        args.unshift(
          '-o',
          'BatchMode=no',
          '-o',
          'PreferredAuthentications=password,keyboard-interactive',
          '-o',
          'PubkeyAuthentication=no'
        );
      } else {
        args.unshift('-o', 'BatchMode=yes');
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
  runSshCommand,
  runSshCopyId,
  probeSshKeyAuth,
  appendTunnelLog,
  startTunnel,
  stopTunnel,
  isProcessAlive,
  buildTunnelSpec
};
