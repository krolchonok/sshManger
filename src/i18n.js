'use strict';

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, 'locales');
const DEFAULT_LOCALE = 'en';

function loadTranslations() {
  const result = {};
  if (!fs.existsSync(LOCALES_DIR)) {
    return result;
  }

  const files = fs.readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name);

  for (const fileName of files) {
    const locale = path.basename(fileName, '.json').trim();
    if (!locale) {
      continue;
    }
    const filePath = path.join(LOCALES_DIR, fileName);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        result[locale] = parsed;
      }
    } catch (error) {
      // Ignore malformed locale files so one bad file does not break the app.
    }
  }

  return result;
}

const TRANSLATIONS = loadTranslations();

function getByPath(dict, key) {
  return String(key || '')
    .split('.')
    .reduce((acc, part) => (acc && acc[part] != null ? acc[part] : null), dict);
}

function format(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, token) => {
    if (Object.prototype.hasOwnProperty.call(vars, token)) {
      return String(vars[token]);
    }
    return `{${token}}`;
  });
}

function getAvailableLocales() {
  const locales = Object.keys(TRANSLATIONS);
  if (!locales.length) {
    return [DEFAULT_LOCALE];
  }
  if (!locales.includes(DEFAULT_LOCALE)) {
    return locales;
  }
  return [DEFAULT_LOCALE, ...locales.filter((code) => code !== DEFAULT_LOCALE)];
}

function getFallbackLocale() {
  const locales = getAvailableLocales();
  if (locales.includes(DEFAULT_LOCALE)) {
    return DEFAULT_LOCALE;
  }
  return locales[0];
}

function getLocaleMeta(locale) {
  const code = String(locale || '');
  const dict = TRANSLATIONS[code];
  const meta = dict && typeof dict.__meta === 'object' ? dict.__meta : {};
  return {
    code,
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : code,
    nativeName: typeof meta.nativeName === 'string' && meta.nativeName.trim() ? meta.nativeName.trim() : code
  };
}

function createI18n(locale) {
  const fallback = getFallbackLocale();
  const selected = TRANSLATIONS[locale] ? locale : fallback;
  return {
    locale: selected,
    t(key, vars = {}) {
      const value = getByPath(TRANSLATIONS[selected], key)
        || getByPath(TRANSLATIONS[fallback], key)
        || key;
      if (typeof value !== 'string') {
        return String(key);
      }
      return format(value, vars);
    }
  };
}

module.exports = {
  createI18n,
  getAvailableLocales,
  getLocaleMeta
};
