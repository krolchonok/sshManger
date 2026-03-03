'use strict';

const TRANSLATIONS = {
  en: {
    appTitle: 'SSHHelper',
    hostPanel: 'Hosts from ~/.ssh/config',
    hostColumns: 'Alias | URL | Port',
    tunnelPanel: 'Tunnels',
    statusReady: 'Ready',
    footerKeys:
      'Tab switch panel | Enter/C connect | A add selected | S start | X stop | D delete selected | R reload | L language | Q quit',
    footerKeysCompact:
      'Tab switch | Enter/C connect | A add selected | S start | X stop | D del selected | R reload | L lang | Q quit',
    noHosts: 'No hosts found in ~/.ssh/config',
    noTunnels: 'No tunnels yet. Press A to add one.',
    connectPromptPattern: 'Selected host is a pattern. Enter concrete hostname',
    connectPromptManual: 'Enter host alias or hostname',
    addTunnelTitle: 'Create tunnel',
    addTunnelStep: 'Add tunnel - Step {step}',
    addHostStep: 'Add host - Step {step}',
    hostAliasPrompt: 'Host alias',
    hostNamePrompt: 'HostName',
    hostUserPrompt: 'User',
    hostPortPrompt: 'Port',
    tunnelNamePrompt: 'Tunnel name (label)',
    tunnelTypePrompt: 'Tunnel type (L/R/D)',
    tunnelHostPrompt: 'SSH host alias or hostname',
    tunnelLocalPortPrompt: 'Local port',
    tunnelRemotePortPrompt: 'Remote port',
    tunnelTargetHostPrompt: 'Target host',
    tunnelTargetPortPrompt: 'Target port',
    tunnelAuthPrompt: 'Use password auth for this tunnel?',
    tunnelPasswordPrompt: 'Password (not saved)',
    tunnelCreated: 'Tunnel saved',
    tunnelStarted: 'Tunnel started',
    tunnelStopped: 'Tunnel stopped',
    tunnelDeleted: 'Tunnel deleted',
    hostAdded: 'Host added to ~/.ssh/config',
    hostDeleted: 'Host deleted from ~/.ssh/config',
    tunnelStartFailed: 'Failed to start tunnel',
    tunnelStopFailed: 'Failed to stop tunnel',
    invalidInput: 'Invalid input',
    sshExitCode: 'SSH session ended with code {code}',
    launchingSsh: 'Launching ssh {host}',
    reloadDone: 'Reloaded hosts and tunnel status',
    languageSet: 'Language switched to {lang}',
    confirmDelete: 'Delete selected tunnel record?',
    deleteDialogTitle: 'Delete tunnel',
    confirmDeleteHost: 'Delete host "{host}" from ~/.ssh/config?',
    deleteHostDialogTitle: 'Delete host',
    yes: 'yes',
    no: 'no',
    btnDelete: 'Delete',
    btnBack: 'Back',
    btnNext: 'Next',
    btnCancel: 'Cancel',
    authAgent: 'agent/key',
    authPassword: 'password',
    tunnelListFmt:
      '[{state}] {name} | {type} {spec} | host:{host} | auth:{auth} | pid:{pid}',
    hostListFmt: '{name}{patternMark}',
    patternMark: ' [pattern]',
    stateRunning: 'running',
    stateStopped: 'stopped',
    statusPrefix: 'Status: '
  },
  ru: {
    appTitle: 'SSHHelper',
    hostPanel: 'Hosts из ~/.ssh/config',
    hostColumns: 'Alias | URL | Порт',
    tunnelPanel: 'Туннели',
    statusReady: 'Готово',
    footerKeys:
      'Tab смена панели | Enter/C(С) подключиться | A(Ф) добавить выбранное | S(Ы) старт | X(Ч) стоп | D(В) удалить выбранное | R(К) обновить | L(Д) язык | Q(Й) выход',
    footerKeysCompact:
      'Tab панель | Enter/C(С) подключение | A(Ф) добавить выбранное | S(Ы) старт | X(Ч) стоп | D(В) удалить выбранное | R(К) обновить | L(Д) язык | Q(Й) выход',
    noHosts: 'В ~/.ssh/config хосты не найдены',
    noTunnels: 'Туннелей пока нет. Нажмите A(Ф) для добавления.',
    connectPromptPattern: 'Выбран шаблон. Введите конкретный hostname',
    connectPromptManual: 'Введите alias или hostname',
    addTunnelTitle: 'Создать туннель',
    addTunnelStep: 'Добавление туннеля - Шаг {step}',
    addHostStep: 'Добавление хоста - Шаг {step}',
    hostAliasPrompt: 'Alias хоста',
    hostNamePrompt: 'HostName',
    hostUserPrompt: 'User',
    hostPortPrompt: 'Порт',
    tunnelNamePrompt: 'Имя туннеля',
    tunnelTypePrompt: 'Тип туннеля (L/R/D)',
    tunnelHostPrompt: 'SSH alias или hostname',
    tunnelLocalPortPrompt: 'Локальный порт',
    tunnelRemotePortPrompt: 'Удаленный порт',
    tunnelTargetHostPrompt: 'Целевой хост',
    tunnelTargetPortPrompt: 'Целевой порт',
    tunnelAuthPrompt: 'Использовать пароль для туннеля?',
    tunnelPasswordPrompt: 'Пароль (не сохраняется)',
    tunnelCreated: 'Туннель сохранен',
    tunnelStarted: 'Туннель запущен',
    tunnelStopped: 'Туннель остановлен',
    tunnelDeleted: 'Туннель удален',
    hostAdded: 'Хост добавлен в ~/.ssh/config',
    hostDeleted: 'Хост удален из ~/.ssh/config',
    tunnelStartFailed: 'Не удалось запустить туннель',
    tunnelStopFailed: 'Не удалось остановить туннель',
    invalidInput: 'Неверный ввод',
    sshExitCode: 'SSH сессия завершилась с кодом {code}',
    launchingSsh: 'Запуск ssh {host}',
    reloadDone: 'Список хостов и статусы туннелей обновлены',
    languageSet: 'Язык переключен на {lang}',
    confirmDelete: 'Удалить запись туннеля?',
    deleteDialogTitle: 'Удаление туннеля',
    confirmDeleteHost: 'Удалить хост "{host}" из ~/.ssh/config?',
    deleteHostDialogTitle: 'Удаление хоста',
    yes: 'да',
    no: 'нет',
    btnDelete: 'Удалить',
    btnBack: 'Назад',
    btnNext: 'Далее',
    btnCancel: 'Отмена',
    authAgent: 'agent/key',
    authPassword: 'password',
    tunnelListFmt:
      '[{state}] {name} | {type} {spec} | host:{host} | auth:{auth} | pid:{pid}',
    hostListFmt: '{name}{patternMark}',
    patternMark: ' [шаблон]',
    stateRunning: 'running',
    stateStopped: 'stopped',
    statusPrefix: 'Статус: '
  }
};

function getByPath(dict, key) {
  return key.split('.').reduce((acc, part) => (acc && acc[part] ? acc[part] : null), dict);
}

function format(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, token) => {
    if (Object.prototype.hasOwnProperty.call(vars, token)) {
      return String(vars[token]);
    }
    return `{${token}}`;
  });
}

function createI18n(locale) {
  const selected = TRANSLATIONS[locale] ? locale : 'en';
  return {
    locale: selected,
    t(key, vars = {}) {
      const value = getByPath(TRANSLATIONS[selected], key) || getByPath(TRANSLATIONS.en, key) || key;
      if (typeof value !== 'string') {
        return key;
      }
      return format(value, vars);
    }
  };
}

function nextLocale(locale) {
  const locales = Object.keys(TRANSLATIONS);
  const idx = locales.indexOf(locale);
  if (idx === -1) {
    return locales[0];
  }
  return locales[(idx + 1) % locales.length];
}

module.exports = {
  createI18n,
  nextLocale
};
