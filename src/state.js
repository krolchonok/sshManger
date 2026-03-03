'use strict';

const fs = require('fs');
const { STATE_FILE, ensureDirs } = require('./paths');

const DEFAULT_STATE = {
  version: 1,
  locale: 'en',
  tunnels: []
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeTunnel(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  return {
    id: item.id || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: item.name || 'unnamed',
    type: item.type || 'L',
    host: item.host || '',
    spec: item.spec || '',
    pid: Number.isInteger(item.pid) ? item.pid : null,
    auth: item.auth === 'password' ? 'password' : 'agent',
    createdAt: item.createdAt || nowIso(),
    updatedAt: item.updatedAt || nowIso(),
    logFile: item.logFile || '',
    lastError: item.lastError || ''
  };
}

function loadState() {
  ensureDirs();

  if (!fs.existsSync(STATE_FILE)) {
    return { ...DEFAULT_STATE };
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const tunnels = Array.isArray(parsed.tunnels) ? parsed.tunnels.map(normalizeTunnel).filter(Boolean) : [];
    return {
      version: Number.isInteger(parsed.version) ? parsed.version : DEFAULT_STATE.version,
      locale: typeof parsed.locale === 'string' ? parsed.locale : DEFAULT_STATE.locale,
      tunnels
    };
  } catch (error) {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  ensureDirs();
  const normalized = {
    version: 1,
    locale: typeof state.locale === 'string' ? state.locale : 'en',
    tunnels: Array.isArray(state.tunnels) ? state.tunnels.map(normalizeTunnel).filter(Boolean) : []
  };
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

module.exports = {
  loadState,
  saveState,
  normalizeTunnel,
  nowIso
};
