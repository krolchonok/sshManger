'use strict';

const fs = require('fs');
const path = require('path');
const { globSync } = require('glob');
const { minimatch } = require('minimatch');
const { SSH_CONFIG_PATH, HOME_DIR } = require('./paths');

const WILDCARD_RE = /[*?!\[\]]/;

function isPatternHost(host) {
  return WILDCARD_RE.test(host);
}

function expandHome(p) {
  if (!p) {
    return p;
  }
  if (p.startsWith('~/')) {
    return path.join(HOME_DIR, p.slice(2));
  }
  return p;
}

function stripComments(line) {
  let out = '';
  let quote = null;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : '';

    if ((ch === '"' || ch === "'") && prev !== '\\') {
      if (!quote) {
        quote = ch;
      } else if (quote === ch) {
        quote = null;
      }
      out += ch;
      continue;
    }

    if (ch === '#' && !quote) {
      break;
    }

    out += ch;
  }

  return out;
}

function splitArgs(line) {
  const tokens = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : '';

    if ((ch === '"' || ch === "'") && prev !== '\\') {
      if (!quote) {
        quote = ch;
      } else if (quote === ch) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch) && !quote) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    if (ch === '\\' && !quote && i + 1 < line.length && /\s/.test(line[i + 1])) {
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function normalizePatterns(args) {
  const patterns = [];
  for (const token of args) {
    const parts = token.split(',').map((value) => value.trim()).filter(Boolean);
    if (parts.length > 0) {
      patterns.push(...parts);
    }
  }
  return patterns;
}

function createSection(patterns, source) {
  return {
    patterns,
    source,
    options: {}
  };
}

function parseConfigFile(filePath, visited, outSections) {
  if (!filePath || visited.has(filePath) || !fs.existsSync(filePath)) {
    return;
  }
  visited.add(filePath);

  const fileDir = path.dirname(filePath);
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  let current = createSection(['*'], filePath);
  outSections.push(current);

  for (const rawLine of lines) {
    const line = stripComments(rawLine).trim();
    if (!line) {
      continue;
    }

    const tokens = splitArgs(line);
    if (tokens.length < 2) {
      continue;
    }

    const keyword = tokens[0].toLowerCase();
    const args = tokens.slice(1);

    if (keyword === 'include') {
      for (const patternInput of args) {
        const patternRaw = expandHome(patternInput);
        const pattern = path.isAbsolute(patternRaw) ? patternRaw : path.join(fileDir, patternRaw);
        const matches = globSync(pattern, { nodir: true, windowsPathsNoEscape: true });
        for (const match of matches.sort()) {
          parseConfigFile(path.resolve(match), visited, outSections);
        }
      }
      continue;
    }

    if (keyword === 'host') {
      current = createSection(normalizePatterns(args), filePath);
      outSections.push(current);
      continue;
    }

    if (keyword === 'hostname' || keyword === 'port' || keyword === 'user') {
      if (current.options[keyword] == null) {
        current.options[keyword] = args.join(' ');
      }
    }
  }
}

function patternMatchesHost(host, pattern) {
  if (!pattern || pattern === '*') {
    return true;
  }
  return minimatch(host, pattern, { nocase: false, dot: true, noglobstar: true });
}

function hostMatchesSection(hostName, patterns) {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  let positiveMatched = false;
  for (const patternRaw of patterns) {
    if (!patternRaw) {
      continue;
    }

    if (patternRaw.startsWith('!')) {
      const negative = patternRaw.slice(1);
      if (patternMatchesHost(hostName, negative)) {
        return false;
      }
      continue;
    }

    if (patternMatchesHost(hostName, patternRaw)) {
      positiveMatched = true;
    }
  }

  return positiveMatched;
}

function collectHostAliases(sections) {
  const aliases = [];
  const seen = new Set();

  for (const section of sections) {
    for (const pattern of section.patterns) {
      if (!pattern || pattern.startsWith('!') || pattern === '*') {
        continue;
      }
      if (seen.has(pattern)) {
        continue;
      }
      seen.add(pattern);
      aliases.push({
        name: pattern,
        source: section.source
      });
    }
  }

  return aliases;
}

function resolveHostDetails(hostName, sections) {
  const resolved = {
    hostname: null,
    port: null,
    user: null
  };

  for (const section of sections) {
    if (!hostMatchesSection(hostName, section.patterns)) {
      continue;
    }

    if (resolved.hostname == null && section.options.hostname) {
      resolved.hostname = section.options.hostname;
    }
    if (resolved.port == null && section.options.port) {
      resolved.port = section.options.port;
    }
    if (resolved.user == null && section.options.user) {
      resolved.user = section.options.user;
    }
  }

  const hostNameValue = resolved.hostname || hostName;
  return {
    hostName: hostNameValue,
    port: resolved.port || '-',
    user: resolved.user || '',
    endpoint: resolved.user ? `${resolved.user}@${hostNameValue}` : hostNameValue
  };
}

function loadHostsFromConfig(configPath = SSH_CONFIG_PATH) {
  const resolved = path.resolve(expandHome(configPath));
  if (!fs.existsSync(resolved)) {
    return [];
  }

  const sections = [];
  parseConfigFile(resolved, new Set(), sections);

  const aliases = collectHostAliases(sections);
  return aliases.map((alias) => {
    const details = resolveHostDetails(alias.name, sections);
    return {
      name: alias.name,
      isPattern: isPatternHost(alias.name),
      source: alias.source,
      hostName: details.hostName,
      endpoint: details.endpoint,
      port: details.port,
      user: details.user
    };
  });
}

function ensureConfigFile(configPath = SSH_CONFIG_PATH) {
  const resolved = path.resolve(expandHome(configPath));
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(resolved)) {
    fs.writeFileSync(resolved, '', 'utf8');
  }
  return resolved;
}

function addHostToConfig(host, configPath = SSH_CONFIG_PATH) {
  const alias = String(host && host.alias ? host.alias : '').trim();
  const hostName = String(host && host.hostName ? host.hostName : '').trim();
  const user = String(host && host.user ? host.user : '').trim();
  const port = String(host && host.port ? host.port : '').trim();

  if (!alias) {
    throw new Error('Host alias is required');
  }
  if (!hostName) {
    throw new Error('HostName is required');
  }

  const resolved = ensureConfigFile(configPath);
  const current = fs.readFileSync(resolved, 'utf8');

  const block = [
    `Host ${alias}`,
    `  HostName ${hostName}`,
    `  User ${user}`,
    `  Port ${port}`
  ].join('\n');

  let next = current;
  if (next.length > 0 && !/\n$/.test(next)) {
    next += '\n';
  }
  if (next.length > 0) {
    next += '\n';
  }
  next += `${block}\n`;

  fs.writeFileSync(resolved, next, 'utf8');
}

function readKeyword(line) {
  const clean = stripComments(line).trim();
  if (!clean) {
    return '';
  }
  const tokens = splitArgs(clean);
  if (tokens.length === 0) {
    return '';
  }
  return tokens[0].toLowerCase();
}

function parseHostPatterns(line) {
  const clean = stripComments(line).trim();
  if (!clean) {
    return [];
  }
  const tokens = splitArgs(clean);
  if (tokens.length < 2 || tokens[0].toLowerCase() !== 'host') {
    return [];
  }
  return normalizePatterns(tokens.slice(1));
}

function deleteHostFromConfig(hostAlias, configPath = SSH_CONFIG_PATH) {
  const alias = String(hostAlias || '').trim();
  if (!alias) {
    throw new Error('Host alias is required');
  }

  const resolved = ensureConfigFile(configPath);
  const current = fs.readFileSync(resolved, 'utf8');
  const lines = current.split(/\r?\n/);
  const out = [];
  let idx = 0;
  let removed = false;

  while (idx < lines.length) {
    const line = lines[idx];
    const keyword = readKeyword(line);

    if (keyword !== 'host') {
      out.push(line);
      idx += 1;
      continue;
    }

    const patterns = parseHostPatterns(line);
    const shouldDelete = patterns.some((pattern) => pattern === alias);
    if (!shouldDelete) {
      out.push(line);
      idx += 1;
      continue;
    }

    removed = true;
    idx += 1;
    while (idx < lines.length) {
      const nextKeyword = readKeyword(lines[idx]);
      if (nextKeyword === 'host' || nextKeyword === 'match') {
        break;
      }
      idx += 1;
    }
  }

  if (!removed) {
    throw new Error(`Host not found: ${alias}`);
  }

  let next = out.join('\n');
  next = next.replace(/\n{3,}/g, '\n\n');
  next = next.replace(/^\n+/, '');
  if (next.length > 0 && !/\n$/.test(next)) {
    next += '\n';
  }
  fs.writeFileSync(resolved, next, 'utf8');
}

module.exports = {
  loadHostsFromConfig,
  isPatternHost,
  addHostToConfig,
  deleteHostFromConfig
};
