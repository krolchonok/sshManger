'use strict';

const fs = require('fs');
const path = require('path');
const { STATE_FILE, ensureDirs } = require('./paths');

const DEFAULT_STATE = {
  version: 1,
  locale: 'en',
  accentColor: 'green',
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
    auth: item.auth === 'password' ? 'password' : (item.auth === 'agent' ? 'agent' : 'auto'),
    createdAt: item.createdAt || nowIso(),
    updatedAt: item.updatedAt || nowIso(),
    logFile: item.logFile || '',
    lastError: item.lastError || ''
  };
}

function normalizeState(state) {
  const source = state && typeof state === 'object' ? state : {};
  return {
    version: Number.isInteger(source.version) ? source.version : DEFAULT_STATE.version,
    locale: typeof source.locale === 'string' ? source.locale : DEFAULT_STATE.locale,
    accentColor: typeof source.accentColor === 'string' && source.accentColor.trim()
      ? source.accentColor.trim().toLowerCase()
      : DEFAULT_STATE.accentColor,
    tunnels: Array.isArray(source.tunnels) ? source.tunnels.map(normalizeTunnel).filter(Boolean) : []
  };
}

function makePortableState(state) {
  const normalized = normalizeState(state);
  normalized.tunnels = normalized.tunnels.map((tunnel) => ({
    ...tunnel,
    pid: null,
    logFile: '',
    lastError: '',
    updatedAt: nowIso()
  }));
  return normalized;
}

function loadState() {
  ensureDirs();

  if (!fs.existsSync(STATE_FILE)) {
    return { ...DEFAULT_STATE };
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (error) {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  ensureDirs();
  const normalized = normalizeState(state);
  normalized.version = 1;
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

function exportConfigToFile(state, filePath) {
  const targetPath = String(filePath || '').trim();
  if (!targetPath) {
    throw new Error('File path is required');
  }

  const dirPath = path.dirname(targetPath);
  if (dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const portableState = makePortableState(state);
  fs.writeFileSync(targetPath, `${JSON.stringify(portableState, null, 2)}\n`, 'utf8');
  return portableState;
}

function importConfigFromFile(filePath) {
  const sourcePath = String(filePath || '').trim();
  if (!sourcePath) {
    throw new Error('File path is required');
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`File not found: ${sourcePath}`);
  }

  const raw = fs.readFileSync(sourcePath, 'utf8');
  const parsed = JSON.parse(raw);
  return makePortableState(parsed);
}

module.exports = {
  loadState,
  saveState,
  exportConfigToFile,
  importConfigFromFile,
  normalizeTunnel,
  normalizeState,
  nowIso
};
