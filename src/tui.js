'use strict';

const path = require('path');
const blessed = require('blessed');
const { createI18n, getAvailableLocales, getLocaleMeta } = require('./i18n');
const {
  startTunnel,
  stopTunnel,
  isProcessAlive,
  buildTunnelSpec,
  runSshCommand,
  runSshCopyId,
  probeSshKeyAuth,
  appendTunnelLog
} = require('./ssh');
const { loadHostsFromConfig, addHostToConfig, deleteHostFromConfig } = require('./sshConfig');
const { nowIso, exportConfigToFile, importConfigFromFile } = require('./state');
const { HOME_DIR, STATE_DIR } = require('./paths');

const DEFAULT_PRIMARY_COLOR = 'green';
const ACCENT_COLOR_OPTIONS = ['green', 'cyan', 'blue', 'magenta', 'yellow', 'red', 'white'];
let primaryColor = DEFAULT_PRIMARY_COLOR;
const DIALOG_BG = 'default';
const DIALOG_FG = 'white';
const BUTTON_MIN_WIDTH = 12;
const BUTTON_BG = 'white';
const BUTTON_FG = 'black';
const BUTTON_FG_ACTIVE = 'black';
const DIALOG_BACK = '__dialog_back__';
const COMMAND_OUTPUT_LIMIT_BYTES = 200 * 1024;

function normalizeAccentColor(color) {
  const normalized = String(color || '').trim().toLowerCase();
  return ACCENT_COLOR_OPTIONS.includes(normalized) ? normalized : DEFAULT_PRIMARY_COLOR;
}

function hideTerminalCursor(screen) {
  if (!screen || !screen.program) {
    return;
  }
  if (typeof screen.program.hideCursor === 'function') {
    screen.program.hideCursor();
  }
  if (typeof screen.program.write === 'function') {
    screen.program.write('\x1b[?25l');
  }
}

function showTerminalCursor(screen) {
  if (!screen || !screen.program) {
    return;
  }
  if (typeof screen.program.showCursor === 'function') {
    screen.program.showCursor();
  }
  if (typeof screen.program.write === 'function') {
    screen.program.write('\x1b[?25h');
  }
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function resolveUserPath(inputPath) {
  const rawPath = String(inputPath || '').trim();
  if (!rawPath) {
    return '';
  }
  if (rawPath === '~') {
    return HOME_DIR;
  }
  if (rawPath.startsWith('~/')) {
    return path.join(HOME_DIR, rawPath.slice(2));
  }
  return path.resolve(rawPath);
}

function defaultConfigExportPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(STATE_DIR, `config-export-${stamp}.json`);
}

function isDialogBack(value) {
  return value === DIALOG_BACK;
}

function isPrintableInputChar(ch) {
  return typeof ch === 'string' && ch.length > 0 && !/[\x00-\x1f\x7f]/.test(ch);
}

function styleDialogButton(button, isActive) {
  button.style.bg = isActive ? primaryColor : BUTTON_BG;
  button.style.fg = isActive ? BUTTON_FG_ACTIVE : BUTTON_FG;
}

function getNodeWidth(screen, node, fallback) {
  if (node && typeof node.width === 'number') {
    return Math.max(1, Math.floor(node.width));
  }

  if (node && typeof node.width === 'string') {
    const match = String(node.width).trim().match(/^(\d+(?:\.\d+)?)%$/);
    if (match) {
      const pct = Number(match[1]);
      if (Number.isFinite(pct)) {
        return Math.max(1, Math.floor((screen.width * pct) / 100));
      }
    }
  }

  if (node && node.lpos) {
    return Math.max(1, node.lpos.xl - node.lpos.xi + 1);
  }

  return Math.max(1, fallback);
}

function getNodeHeight(screen, node, fallback) {
  if (node && typeof node.height === 'number') {
    return Math.max(1, Math.floor(node.height));
  }

  if (node && typeof node.height === 'string') {
    const match = String(node.height).trim().match(/^(\d+(?:\.\d+)?)%$/);
    if (match) {
      const pct = Number(match[1]);
      if (Number.isFinite(pct)) {
        return Math.max(1, Math.floor((screen.height * pct) / 100));
      }
    }
  }

  if (node && node.lpos) {
    return Math.max(1, node.lpos.yl - node.lpos.yi + 1);
  }

  return Math.max(1, fallback);
}

function layoutDialogButtons(screen, box, buttons, options = {}) {
  const safeButtons = Array.isArray(buttons) ? buttons.filter(Boolean) : [];
  if (!safeButtons.length) {
    return;
  }

  const top = Number.isInteger(options.top) ? options.top : 7;
  const left = Number.isInteger(options.left) ? options.left : 2;
  const right = Number.isInteger(options.right) ? options.right : 2;
  const gap = Number.isInteger(options.gap) ? options.gap : 1;
  const boxWidth = getNodeWidth(screen, box, Math.floor(screen.width * 0.7));
  const available = Math.max(1, boxWidth - left - right - 2);

  const items = safeButtons.map((button) => {
    const rawWidth = Number(button._baseDialogWidth || button.width);
    const baseWidth = Number.isFinite(rawWidth) && rawWidth > 0
      ? Math.floor(rawWidth)
      : BUTTON_MIN_WIDTH;
    return { button, baseWidth: Math.max(1, Math.min(baseWidth, available)) };
  });

  const rows = [{ items: [], used: 0 }];
  for (const item of items) {
    const row = rows[rows.length - 1];
    const required = row.items.length > 0 ? gap + item.baseWidth : item.baseWidth;
    if (row.items.length > 0 && row.used + required > available) {
      rows.push({ items: [item], used: item.baseWidth });
      continue;
    }
    row.items.push(item);
    row.used += required;
  }

  rows.forEach((row, rowIndex) => {
    const stretchRow = true;
    let offset = left;

    if (stretchRow) {
      const totalGap = gap * Math.max(0, row.items.length - 1);
      const totalBase = row.items.reduce((sum, entry) => sum + entry.baseWidth, 0);
      const free = Math.max(0, available - totalGap - totalBase);
      const addPerButton = Math.floor(free / row.items.length);
      let remainder = free - addPerButton * row.items.length;

      row.items.forEach(({ button, baseWidth }) => {
        const width = Math.max(1, baseWidth + addPerButton + (remainder > 0 ? 1 : 0));
        if (remainder > 0) {
          remainder -= 1;
        }
        button.top = top + rowIndex;
        button.left = offset;
        button.width = width;
        offset += width + gap;
      });
      return;
    }

    row.items.forEach(({ button, baseWidth }) => {
      button.top = top + rowIndex;
      button.left = offset;
      button.width = baseWidth;
      offset += baseWidth + gap;
    });
  });
}

function bindDialogButtonLayout(screen, box, buttons, options = {}) {
  const applyLayout = () => layoutDialogButtons(screen, box, buttons, options);
  const onResize = () => {
    if (box.detached) {
      return;
    }
    applyLayout();
    screen.render();
  };

  screen.on('resize', onResize);
  box.on('destroy', () => {
    if (typeof screen.off === 'function') {
      screen.off('resize', onResize);
      return;
    }
    screen.removeListener('resize', onResize);
  });

  applyLayout();
  return applyLayout;
}

function createDialogButton(parent, left, label) {
  const baseWidth = Math.max(BUTTON_MIN_WIDTH, label.length + 4);
  const button = blessed.box({
    parent,
    top: 7,
    left,
    width: baseWidth,
    height: 1,
    align: 'center',
    content: ` ${label} `,
    mouse: true,
    clickable: true,
    autoFocus: false,
    keys: true,
    style: {
      fg: BUTTON_FG,
      bg: BUTTON_BG,
      hover: { fg: BUTTON_FG_ACTIVE, bg: primaryColor }
    }
  });
  button._baseDialogWidth = baseWidth;
  return button;
}

function createDialogTitleBadge(parent, title) {
  const text = String(title || '').trim();
  if (!text) {
    return null;
  }
  return blessed.box({
    parent,
    top: -1,
    left: 'center',
    width: Math.max(12, text.length + 4),
    height: 3,
    border: 'line',
    align: 'center',
    content: ` ${text} `,
    style: {
      fg: DIALOG_FG,
      bg: DIALOG_BG,
      border: { fg: DIALOG_FG, bg: DIALOG_BG }
    }
  });
}

function showScrollableOutput(screen, text, labels = {}) {
  return new Promise((resolve) => {
    const dialogLabel = labels.dialogLabel || 'Output';
    const hintText = labels.hintText || 'Esc/Enter close | Up/Down/PgUp/PgDn scroll';
    const closeOnF1 = Boolean(labels.closeOnF1);
    const content = String(text || '');

    const box = blessed.box({
      parent: screen,
      border: 'line',
      width: '90%',
      height: '80%',
      top: 'center',
      left: 'center',
      keys: true,
      mouse: true,
      style: {
        border: { fg: primaryColor, bg: DIALOG_BG },
        bg: DIALOG_BG,
        fg: DIALOG_FG
      }
    });
    createDialogTitleBadge(box, dialogLabel);

    const output = blessed.box({
      parent: box,
      border: 'line',
      top: 1,
      left: 2,
      right: 2,
      bottom: 3,
      keys: true,
      vi: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      content: content.length > 0 ? content : ' ',
      style: {
        border: { fg: primaryColor, bg: DIALOG_BG },
        bg: DIALOG_BG,
        fg: DIALOG_FG
      }
    });

    blessed.text({
      parent: box,
      left: 2,
      right: 2,
      bottom: 1,
      height: 1,
      content: hintText,
      style: {
        bg: DIALOG_BG,
        fg: DIALOG_FG
      }
    });

    let done = false;
    function close() {
      if (done) {
        return;
      }
      done = true;
      box.destroy();
      screen.render();
      resolve();
    }

    function handleKey(ch, key) {
      if (done) {
        return;
      }

      if (key && key.full === 'C-c') {
        return;
      }

      const keyName = key ? key.name : '';
      if (closeOnF1 && keyName === 'f1') {
        close();
        return;
      }
      if (keyName === 'escape' || keyName === 'enter' || keyName === 'q' || keyName === 'Q' || ch === 'q' || ch === 'Q') {
        close();
        return;
      }

      if (keyName === 'up' || keyName === 'k') {
        output.scroll(-1);
        screen.render();
        return;
      }

      if (keyName === 'down' || keyName === 'j') {
        output.scroll(1);
        screen.render();
        return;
      }

      if (keyName === 'pageup') {
        output.scroll(-Math.max(1, Math.floor(getNodeHeight(screen, output, 12) / 2)));
        screen.render();
        return;
      }

      if (keyName === 'pagedown') {
        output.scroll(Math.max(1, Math.floor(getNodeHeight(screen, output, 12) / 2)));
        screen.render();
        return;
      }

      if (keyName === 'home') {
        output.setScroll(0);
        screen.render();
        return;
      }

      if (keyName === 'end') {
        output.setScrollPerc(100);
        screen.render();
      }
    }

    box.on('keypress', handleKey);
    output.on('keypress', handleKey);
    output.on('click', () => output.focus());
    box.on('click', () => output.focus());

    output.focus();
    screen.render();
  });
}

function fitSingleLine(text, width) {
  const safeWidth = Number.isInteger(width) && width > 0 ? width : 40;
  if (text.length <= safeWidth) {
    return text;
  }
  return text.slice(text.length - safeWidth);
}

function getFrameInputWidth(screen, frame) {
  if (frame && frame.lpos) {
    return Math.max(1, frame.lpos.xl - frame.lpos.xi - 3);
  }
  return Math.max(1, Math.floor(screen.width * 0.7) - 10);
}

function renderEditableLine(value, cursorIndex, width, options = {}) {
  const mask = Boolean(options.mask);
  const showCursor = options.showCursor !== false;
  const cursorChar = options.cursorChar || '|';
  const safeWidth = Math.max(1, width);
  const source = mask ? '*'.repeat(value.length) : value;
  const safeCursor = Math.max(0, Math.min(cursorIndex, source.length));
  const raw = showCursor
    ? `${source.slice(0, safeCursor)}${cursorChar}${source.slice(safeCursor)}`
    : (source.length > 0 ? source : ' ');

  if (raw.length <= safeWidth) {
    return raw;
  }

  if (!showCursor) {
    return fitSingleLine(raw, safeWidth);
  }

  const markerPos = safeCursor;
  let start = Math.max(0, markerPos - safeWidth + 1);
  start = Math.min(start, raw.length - safeWidth);
  return raw.slice(start, start + safeWidth);
}

function clipCell(value, width) {
  const raw = String(value || '');
  if (raw.length <= width) {
    return raw;
  }
  if (width <= 1) {
    return raw.slice(0, width);
  }
  return `${raw.slice(0, width - 1)}~`;
}

function formatHostTableRow(host, patternMark) {
  const alias = clipCell(`${host.name}${patternMark}`, 24).padEnd(24, ' ');
  const endpoint = clipCell(host.endpoint || host.hostName || host.name, 42).padEnd(42, ' ');
  const port = clipCell(host.port || '-', 6).padEnd(6, ' ');
  return `${alias} | ${endpoint} | ${port}`;
}

function askText(screen, question, initial = '', labels = {}) {
  return new Promise((resolve) => {
    const nextLabel = labels.nextLabel || 'Next';
    const cancelLabel = labels.cancelLabel || 'Cancel';
    const backLabel = labels.backLabel || '';
    const hasBack = Boolean(backLabel);
    const dialogLabel = labels.dialogLabel || ' Input ';
    const box = blessed.box({
      parent: screen,
      border: 'line',
      width: '70%',
      height: 11,
      top: 'center',
      left: 'center',
      keys: true,
      mouse: true,
      style: {
        border: { fg: 'white', bg: DIALOG_BG },
        bg: DIALOG_BG,
        fg: DIALOG_FG
      }
    });
    createDialogTitleBadge(box, dialogLabel);

    blessed.text({
      parent: box,
      top: 0,
      left: 2,
      right: 2,
      content: `${question}:`,
      style: {
        bg: DIALOG_BG,
        fg: DIALOG_FG
      }
    });

    const inputFrame = blessed.box({
      parent: box,
      border: 'line',
      top: 1,
      left: 2,
      right: 2,
      height: 3,
      mouse: true,
      clickable: true,
      autoFocus: false,
      style: {
        border: { fg: primaryColor, bg: DIALOG_BG },
        bg: DIALOG_BG
      }
    });

    const inputText = blessed.text({
      parent: inputFrame,
      top: 0,
      left: 1,
      right: 1,
      height: 1,
      content: ' ',
      style: {
        fg: DIALOG_FG,
        bg: DIALOG_BG
      }
    });

    const hint = blessed.text({
      parent: box,
      top: 4,
      left: 2,
      content: hasBack ? 'Enter = Select | Esc = Cancel | Tab switches control' : 'Enter = Next | Esc = Cancel | Tab switches control',
      style: {
        bg: DIALOG_BG,
        fg: DIALOG_FG
      }
    });

    const nextBtn = createDialogButton(box, 2, nextLabel);
    const backBtn = hasBack ? createDialogButton(box, nextBtn.left + nextBtn.width + 1, backLabel) : null;
    const cancelBtn = createDialogButton(
      box,
      (backBtn || nextBtn).left + (backBtn || nextBtn).width + 1,
      cancelLabel
    );
    const layoutButtons = hasBack ? [backBtn, nextBtn, cancelBtn] : [nextBtn, cancelBtn];
    const applyButtonLayout = bindDialogButtonLayout(
      screen,
      box,
      layoutButtons,
      { top: 7 }
    );
    const buttonOrder = hasBack ? ['back', 'next', 'cancel'] : ['next', 'cancel'];

    let done = false;
    let value = typeof initial === 'string' ? initial : '';
    let active = 'input';
    let cursorIndex = value.length;

    function finish(result) {
      if (done) {
        return;
      }
      done = true;
      box.destroy();
      screen.render();
      resolve(result);
    }

    function setActive(nextActive) {
      active = nextActive;
      inputFrame.style.border.fg = active === 'input' ? primaryColor : 'white';
      inputFrame.style.border.bg = DIALOG_BG;
      styleDialogButton(nextBtn, active === 'next');
      if (backBtn) {
        styleDialogButton(backBtn, active === 'back');
      }
      styleDialogButton(cancelBtn, active === 'cancel');
      cursorIndex = Math.max(0, Math.min(cursorIndex, value.length));
      const visible = renderEditableLine(value, cursorIndex, getFrameInputWidth(screen, inputFrame), {
        showCursor: active === 'input'
      });
      inputText.setContent(visible);
      screen.render();
    }

    function cancel() {
      finish(null);
    }

    function submit() {
      const trimmed = value.trim();
      finish(trimmed.length > 0 ? trimmed : null);
    }

    function cycleForward() {
      const order = ['input', ...buttonOrder];
      const idx = order.indexOf(active);
      setActive(idx === -1 || idx >= order.length - 1 ? 'input' : order[idx + 1]);
    }

    function cycleBackward() {
      const order = ['input', ...buttonOrder];
      const idx = order.indexOf(active);
      setActive(idx <= 0 ? order[order.length - 1] : order[idx - 1]);
    }

    function moveButtonFocus(delta) {
      if (active === 'input') {
        return;
      }
      const idx = buttonOrder.indexOf(active);
      if (idx === -1) {
        setActive(buttonOrder[0]);
        return;
      }
      const next = (idx + delta + buttonOrder.length) % buttonOrder.length;
      setActive(buttonOrder[next]);
    }

    function handleKey(ch, key) {
      if (done) {
        return;
      }
      if (key && key.full === 'C-c') {
        return;
      }

      if (key && key.name === 'escape') {
        cancel();
        return;
      }

      if (key && key.name === 'tab') {
        cycleForward();
        return;
      }

      if (key && key.name === 'S-tab') {
        cycleBackward();
        return;
      }

      if (key && key.name === 'enter') {
        if (active === 'cancel') {
          cancel();
          return;
        }
        if (active === 'back') {
          finish(DIALOG_BACK);
          return;
        }
        submit();
        return;
      }

      if (active !== 'input' && key && (key.name === 'left' || key.name === 'right')) {
        moveButtonFocus(key.name === 'left' ? -1 : 1);
        return;
      }

      if (active !== 'input' && (isPrintableInputChar(ch) || (key && ['backspace', 'delete', 'home', 'end', 'left', 'right'].includes(key.name)))) {
        setActive('input');
      }

      if (active !== 'input') {
        return;
      }

      if (key && key.name === 'left') {
        if (cursorIndex > 0) {
          cursorIndex -= 1;
          setActive('input');
        }
        return;
      }

      if (key && key.name === 'right') {
        if (cursorIndex < value.length) {
          cursorIndex += 1;
          setActive('input');
        }
        return;
      }

      if (key && key.name === 'home') {
        cursorIndex = 0;
        setActive('input');
        return;
      }

      if (key && key.name === 'end') {
        cursorIndex = value.length;
        setActive('input');
        return;
      }

      if (key && key.name === 'backspace') {
        if (cursorIndex > 0) {
          value = `${value.slice(0, cursorIndex - 1)}${value.slice(cursorIndex)}`;
          cursorIndex -= 1;
          setActive('input');
        }
        return;
      }

      if (key && key.name === 'delete') {
        if (cursorIndex < value.length) {
          value = `${value.slice(0, cursorIndex)}${value.slice(cursorIndex + 1)}`;
          setActive('input');
        }
        return;
      }

      if (isPrintableInputChar(ch)) {
        value = `${value.slice(0, cursorIndex)}${ch}${value.slice(cursorIndex)}`;
        cursorIndex += ch.length;
        setActive('input');
      }
    }

    box.on('keypress', handleKey);
    inputFrame.on('keypress', handleKey);
    nextBtn.on('keypress', handleKey);
    if (backBtn) {
      backBtn.on('keypress', handleKey);
    }
    cancelBtn.on('keypress', handleKey);

    inputFrame.on('click', () => setActive('input'));
    nextBtn.on('click', () => {
      setActive('next');
      submit();
    });
    if (backBtn) {
      backBtn.on('click', () => {
        setActive('back');
        finish(DIALOG_BACK);
      });
    }
    cancelBtn.on('click', () => {
      setActive('cancel');
      cancel();
    });

    box.focus();
    setActive('input');
    hint.setContent(hint.content);
  });
}

function askYesNo(screen, text, labels = {}) {
  return new Promise((resolve) => {
    const yesLabel = labels.yesLabel || 'Yes';
    const noLabel = labels.noLabel || 'No';
    const backLabel = labels.backLabel || '';
    const hasBack = Boolean(backLabel);
    const dialogLabel = labels.dialogLabel || ' Confirm ';
    const box = blessed.box({
      parent: screen,
      border: 'line',
      width: '70%',
      height: 9,
      top: 'center',
      left: 'center',
      keys: true,
      mouse: true,
      style: {
        border: { fg: 'white', bg: DIALOG_BG },
        bg: DIALOG_BG,
        fg: DIALOG_FG
      }
    });
    createDialogTitleBadge(box, dialogLabel);

    blessed.text({
      parent: box,
      top: 1,
      left: 2,
      right: 2,
      content: text,
      style: {
        bg: DIALOG_BG,
        fg: DIALOG_FG
      }
    });

    blessed.text({
      parent: box,
      top: 3,
      left: 2,
      content: 'Enter = selected button | Y/N shortcuts',
      style: {
        bg: DIALOG_BG,
        fg: DIALOG_FG
      }
    });

    const yesBtn = createDialogButton(box, 2, yesLabel);
    const noBtn = createDialogButton(box, yesBtn.left + yesBtn.width + 1, noLabel);
    const backBtn = hasBack ? createDialogButton(box, noBtn.left + noBtn.width + 1, backLabel) : null;
    const applyButtonLayout = bindDialogButtonLayout(
      screen,
      box,
      [yesBtn, noBtn, backBtn],
      { top: 6 }
    );
    const buttonOrder = hasBack ? ['yes', 'no', 'back'] : ['yes', 'no'];
    let done = false;
    let active = 'yes';

    function finish(value) {
      if (done) {
        return;
      }
      done = true;
      box.destroy();
      screen.render();
      if (isDialogBack(value)) {
        resolve(DIALOG_BACK);
        return;
      }
      resolve(Boolean(value));
    }

    function setActive(nextActive) {
      active = nextActive;
      styleDialogButton(yesBtn, active === 'yes');
      styleDialogButton(noBtn, active === 'no');
      if (backBtn) {
        styleDialogButton(backBtn, active === 'back');
      }
      screen.render();
    }

    function cycleButtons(delta) {
      const idx = buttonOrder.indexOf(active);
      if (idx === -1) {
        setActive(buttonOrder[0]);
        return;
      }
      const next = (idx + delta + buttonOrder.length) % buttonOrder.length;
      setActive(buttonOrder[next]);
    }

    function handleKey(ch, key) {
      if (done) {
        return;
      }
      if (key && key.full === 'C-c') {
        return;
      }

      if (!key) {
        return;
      }

      if (key.name === 'escape') {
        finish(false);
        return;
      }
      if (key.name === 'tab' || key.name === 'S-tab') {
        cycleButtons(1);
        return;
      }
      if (key.name === 'left') {
        cycleButtons(-1);
        return;
      }
      if (key.name === 'right') {
        cycleButtons(1);
        return;
      }
      if (key.name === 'enter') {
        if (active === 'back') {
          finish(DIALOG_BACK);
          return;
        }
        finish(active === 'yes');
        return;
      }
      if (key.name === 'y' || key.name === 'Y' || key.name === 'н' || key.name === 'Н') {
        finish(true);
        return;
      }
      if (key.name === 'n' || key.name === 'N' || key.name === 'т' || key.name === 'Т' || key.name === 'q' || key.name === 'й') {
        finish(false);
        return;
      }
      if (hasBack && (key.name === 'b' || key.name === 'B' || key.name === 'и' || key.name === 'И')) {
        finish(DIALOG_BACK);
      }
    }

    box.on('keypress', handleKey);
    yesBtn.on('keypress', handleKey);
    noBtn.on('keypress', handleKey);
    if (backBtn) {
      backBtn.on('keypress', handleKey);
    }

    yesBtn.on('click', () => {
      setActive('yes');
      finish(true);
    });
    noBtn.on('click', () => {
      setActive('no');
      finish(false);
    });
    if (backBtn) {
      backBtn.on('click', () => {
        setActive('back');
        finish(DIALOG_BACK);
      });
    }

    box.focus();
    setActive('yes');
  });
}

function askSecret(screen, label, labels = {}) {
  return new Promise((resolve) => {
    const nextLabel = labels.nextLabel || 'Next';
    const cancelLabel = labels.cancelLabel || 'Cancel';
    const backLabel = labels.backLabel || '';
    const hasBack = Boolean(backLabel);
    const dialogLabel = labels.dialogLabel || ' Secret ';
    const box = blessed.box({
      parent: screen,
      border: 'line',
      width: '70%',
      height: 11,
      top: 'center',
      left: 'center',
      keys: true,
      mouse: true,
      style: {
        border: { fg: 'yellow', bg: DIALOG_BG },
        bg: DIALOG_BG,
        fg: DIALOG_FG
      }
    });
    createDialogTitleBadge(box, dialogLabel);

    blessed.text({
      parent: box,
      top: 0,
      left: 2,
      right: 2,
      content: `${label}:`,
      style: {
        bg: DIALOG_BG,
        fg: DIALOG_FG
      }
    });

    const inputFrame = blessed.box({
      parent: box,
      border: 'line',
      top: 1,
      left: 2,
      right: 2,
      height: 3,
      mouse: true,
      clickable: true,
      autoFocus: false,
      style: {
        border: { fg: primaryColor, bg: DIALOG_BG },
        bg: DIALOG_BG
      }
    });

    const inputText = blessed.text({
      parent: inputFrame,
      top: 0,
      left: 1,
      right: 1,
      height: 1,
      content: ' ',
      style: {
        fg: DIALOG_FG,
        bg: DIALOG_BG
      }
    });

    blessed.text({
      parent: box,
      top: 4,
      left: 2,
      content: hasBack ? 'Enter = Select | Esc = Cancel | Tab switches control' : 'Enter = Next | Esc = Cancel | Tab switches control',
      style: {
        bg: DIALOG_BG,
        fg: DIALOG_FG
      }
    });

    const nextBtn = createDialogButton(box, 2, nextLabel);
    const backBtn = hasBack ? createDialogButton(box, nextBtn.left + nextBtn.width + 1, backLabel) : null;
    const cancelBtn = createDialogButton(
      box,
      (backBtn || nextBtn).left + (backBtn || nextBtn).width + 1,
      cancelLabel
    );
    const layoutButtons = hasBack ? [backBtn, nextBtn, cancelBtn] : [nextBtn, cancelBtn];
    const applyButtonLayout = bindDialogButtonLayout(
      screen,
      box,
      layoutButtons,
      { top: 7 }
    );
    const buttonOrder = hasBack ? ['back', 'next', 'cancel'] : ['next', 'cancel'];

    let done = false;
    let value = '';
    let active = 'input';
    let cursorIndex = 0;

    function finish(result) {
      if (done) {
        return;
      }
      done = true;
      box.destroy();
      screen.render();
      resolve(result);
    }

    function setActive(nextActive) {
      active = nextActive;
      inputFrame.style.border.fg = active === 'input' ? primaryColor : 'white';
      inputFrame.style.border.bg = DIALOG_BG;
      styleDialogButton(nextBtn, active === 'next');
      if (backBtn) {
        styleDialogButton(backBtn, active === 'back');
      }
      styleDialogButton(cancelBtn, active === 'cancel');
      cursorIndex = Math.max(0, Math.min(cursorIndex, value.length));
      const visible = renderEditableLine(value, cursorIndex, getFrameInputWidth(screen, inputFrame), {
        showCursor: active === 'input',
        mask: true
      });
      inputText.setContent(visible);
      screen.render();
    }

    function cancel() {
      finish(null);
    }

    function submit() {
      const trimmed = value.trim();
      finish(trimmed.length > 0 ? trimmed : null);
    }

    function cycleForward() {
      const order = ['input', ...buttonOrder];
      const idx = order.indexOf(active);
      setActive(idx === -1 || idx >= order.length - 1 ? 'input' : order[idx + 1]);
    }

    function cycleBackward() {
      const order = ['input', ...buttonOrder];
      const idx = order.indexOf(active);
      setActive(idx <= 0 ? order[order.length - 1] : order[idx - 1]);
    }

    function moveButtonFocus(delta) {
      if (active === 'input') {
        return;
      }
      const idx = buttonOrder.indexOf(active);
      if (idx === -1) {
        setActive(buttonOrder[0]);
        return;
      }
      const next = (idx + delta + buttonOrder.length) % buttonOrder.length;
      setActive(buttonOrder[next]);
    }

    function handleKey(ch, key) {
      if (done) {
        return;
      }
      if (key && key.full === 'C-c') {
        return;
      }

      if (key && key.name === 'escape') {
        cancel();
        return;
      }

      if (key && key.name === 'tab') {
        cycleForward();
        return;
      }

      if (key && key.name === 'S-tab') {
        cycleBackward();
        return;
      }

      if (key && key.name === 'enter') {
        if (active === 'cancel') {
          cancel();
          return;
        }
        if (active === 'back') {
          finish(DIALOG_BACK);
          return;
        }
        submit();
        return;
      }

      if (active !== 'input' && key && (key.name === 'left' || key.name === 'right')) {
        moveButtonFocus(key.name === 'left' ? -1 : 1);
        return;
      }

      if (active !== 'input' && (isPrintableInputChar(ch) || (key && ['backspace', 'delete', 'home', 'end', 'left', 'right'].includes(key.name)))) {
        setActive('input');
      }

      if (active !== 'input') {
        return;
      }

      if (key && key.name === 'left') {
        if (cursorIndex > 0) {
          cursorIndex -= 1;
          setActive('input');
        }
        return;
      }

      if (key && key.name === 'right') {
        if (cursorIndex < value.length) {
          cursorIndex += 1;
          setActive('input');
        }
        return;
      }

      if (key && key.name === 'home') {
        cursorIndex = 0;
        setActive('input');
        return;
      }

      if (key && key.name === 'end') {
        cursorIndex = value.length;
        setActive('input');
        return;
      }

      if (key && key.name === 'backspace') {
        if (cursorIndex > 0) {
          value = `${value.slice(0, cursorIndex - 1)}${value.slice(cursorIndex)}`;
          cursorIndex -= 1;
          setActive('input');
        }
        return;
      }

      if (key && key.name === 'delete') {
        if (cursorIndex < value.length) {
          value = `${value.slice(0, cursorIndex)}${value.slice(cursorIndex + 1)}`;
          setActive('input');
        }
        return;
      }

      if (isPrintableInputChar(ch)) {
        value = `${value.slice(0, cursorIndex)}${ch}${value.slice(cursorIndex)}`;
        cursorIndex += ch.length;
        setActive('input');
      }
    }

    box.on('keypress', handleKey);
    inputFrame.on('keypress', handleKey);
    nextBtn.on('keypress', handleKey);
    if (backBtn) {
      backBtn.on('keypress', handleKey);
    }
    cancelBtn.on('keypress', handleKey);

    inputFrame.on('click', () => setActive('input'));
    nextBtn.on('click', () => {
      setActive('next');
      submit();
    });
    if (backBtn) {
      backBtn.on('click', () => {
        setActive('back');
        finish(DIALOG_BACK);
      });
    }
    cancelBtn.on('click', () => {
      setActive('cancel');
      cancel();
    });

    box.focus();
    setActive('input');
  });
}

function isValidPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

function markTunnelStatus(tunnel) {
  if (!tunnel.pid) {
    return 'stopped';
  }
  return isProcessAlive(tunnel.pid) ? 'running' : 'stopped';
}

async function runTui({ state, hosts, saveState }) {
  state.accentColor = normalizeAccentColor(state.accentColor);
  primaryColor = state.accentColor;
  let locale = state.locale || 'en';
  let i18n = createI18n(locale);

  return new Promise((resolve) => {
    const screen = blessed.screen({
      smartCSR: true,
      fullUnicode: false,
      dockBorders: true,
      autoPadding: true,
      mouse: true
    });
    hideTerminalCursor(screen);
    if (!Array.isArray(screen.ignoreLocked)) {
      screen.ignoreLocked = [];
    }
    if (!screen.ignoreLocked.includes('C-c')) {
      screen.ignoreLocked.push('C-c');
    }

    const hostList = blessed.list({
      parent: screen,
      label: ` ${i18n.t('hostPanel')} [${i18n.t('hostColumns')}] `,
      border: 'line',
      top: 0,
      left: 0,
      width: '50%',
      height: 10,
      keys: false,
      vi: false,
      mouse: false,
      style: {
        selected: {
          bg: 'blue'
        },
        border: { fg: 'cyan' }
      }
    });

    const tunnelList = blessed.list({
      parent: screen,
      label: ` ${i18n.t('tunnelPanel')} `,
      border: 'line',
      top: 0,
      left: '50%',
      width: '50%',
      height: 10,
      keys: false,
      vi: false,
      mouse: false,
      style: {
        selected: {
          bg: 'blue'
        },
        border: { fg: 'magenta' }
      }
    });

    const status = blessed.box({
      parent: screen,
      border: 'line',
      top: 10,
      height: 3,
      left: 0,
      width: '100%',
      content: `${i18n.t('statusPrefix')}${i18n.t('statusReady')}`,
      style: { border: { fg: primaryColor } }
    });

    const footer = blessed.box({
      parent: screen,
      top: 13,
      height: 1,
      left: 0,
      width: '100%',
      content: i18n.t('footerKeys'),
      wrap: true,
      style: { fg: DIALOG_FG }
    });

    let focusLeft = true;
    let hostRows = [];
    let closing = false;
    let modalDepth = 0;

    function beginModal() {
      modalDepth += 1;
      screen.grabKeys = true;
    }

    function endModal() {
      modalDepth = Math.max(0, modalDepth - 1);
      if (modalDepth === 0) {
        screen.grabKeys = false;
      }
    }

    async function askTextModal(question, initial = '', options = {}) {
      beginModal();
      try {
        return await askText(screen, question, initial, {
          dialogLabel: options.dialogLabel || 'Input',
          nextLabel: i18n.t('btnNext'),
          cancelLabel: i18n.t('btnCancel'),
          backLabel: options.allowBack ? i18n.t('btnBack') : ''
        });
      } finally {
        endModal();
      }
    }

    async function askYesNoModal(text, options = {}) {
      beginModal();
      try {
        return await askYesNo(screen, text, {
          dialogLabel: options.dialogLabel || 'Confirm',
          yesLabel: options.yesLabel || i18n.t('yes'),
          noLabel: options.noLabel || i18n.t('no'),
          backLabel: options.allowBack ? i18n.t('btnBack') : ''
        });
      } finally {
        endModal();
      }
    }

    async function askSecretModal(label, options = {}) {
      beginModal();
      try {
        return await askSecret(screen, label, {
          dialogLabel: options.dialogLabel || 'Secret',
          nextLabel: i18n.t('btnNext'),
          cancelLabel: i18n.t('btnCancel'),
          backLabel: options.allowBack ? i18n.t('btnBack') : ''
        });
      } finally {
        endModal();
      }
    }

    async function showOutputModal(text, options = {}) {
      beginModal();
      try {
        return await showScrollableOutput(screen, text, {
          dialogLabel: options.dialogLabel || i18n.t('commandOutputTitle'),
          hintText: options.hintText || i18n.t('commandOutputHint'),
          closeOnF1: Boolean(options.closeOnF1)
        });
      } finally {
        endModal();
      }
    }

    async function askAddStepInput(step, question, initial = '', options = {}) {
      return askTextModal(question, initial, {
        dialogLabel: i18n.t('addTunnelStep', { step }),
        allowBack: Boolean(options.allowBack)
      });
    }

    async function askAddStepConfirm(step, text, options = {}) {
      return askYesNoModal(text, {
        dialogLabel: i18n.t('addTunnelStep', { step }),
        allowBack: Boolean(options.allowBack)
      });
    }

    async function askAddHostStepInput(step, question, initial = '', options = {}) {
      return askTextModal(question, initial, {
        dialogLabel: i18n.t('addHostStep', { step }),
        allowBack: Boolean(options.allowBack)
      });
    }

    async function askAddStepPort(step, question, options = {}) {
      while (true) {
        const raw = await askAddStepInput(step, question, '', options);
        if (raw === null || isDialogBack(raw)) {
          return raw;
        }
        if (isValidPort(raw)) {
          return Number(raw);
        }
        setStatus(i18n.t('invalidInput'));
      }
    }

    function applyLayout() {
      const compact = screen.width < 110 || screen.height < 26;
      const titleHeight = 0;
      const statusHeight = 3;
      const footerHeight = compact ? 2 : 1;
      const bodyHeight = Math.max(4, screen.height - titleHeight - statusHeight - footerHeight);
      const bodyTop = titleHeight;

      if (compact) {
        const hostHeight = Math.max(2, Math.floor(bodyHeight / 2));
        const tunnelHeight = Math.max(2, bodyHeight - hostHeight);

        hostList.top = bodyTop;
        hostList.left = 0;
        hostList.width = '100%';
        hostList.height = hostHeight;

        tunnelList.top = bodyTop + hostHeight;
        tunnelList.left = 0;
        tunnelList.width = '100%';
        tunnelList.height = tunnelHeight;
      } else {
        hostList.top = bodyTop;
        hostList.left = 0;
        hostList.width = '50%';
        hostList.height = bodyHeight;

        tunnelList.top = bodyTop;
        tunnelList.left = '50%';
        tunnelList.width = '50%';
        tunnelList.height = bodyHeight;
      }

      status.top = bodyTop + bodyHeight;
      status.height = statusHeight;
      status.left = 0;
      status.width = '100%';

      footer.top = bodyTop + bodyHeight + statusHeight;
      footer.height = footerHeight;
      footer.left = 0;
      footer.width = '100%';
      footer.setContent(` ${i18n.t(compact ? 'footerKeysCompact' : 'footerKeys')}`);
    }

    function finalize(action) {
      if (closing) {
        return;
      }
      closing = true;
      showTerminalCursor(screen);
      screen.destroy();
      resolve(action);
    }

    function selectedHost() {
      if (hostRows.length === 0) {
        return null;
      }
      const idx = hostList.selected;
      if (idx < 0 || idx >= hostRows.length) {
        return hostRows[0];
      }
      return hostRows[idx];
    }

    function selectedTunnel() {
      if (!Array.isArray(state.tunnels) || state.tunnels.length === 0) {
        return null;
      }
      const idx = tunnelList.selected;
      if (idx < 0 || idx >= state.tunnels.length) {
        return state.tunnels[0];
      }
      return state.tunnels[idx];
    }

    function setStatus(text) {
      if (closing) {
        return;
      }
      status.setContent(`${i18n.t('statusPrefix')}${text}`);
      screen.render();
    }

    function buildCommandReport(host, command, result) {
      const outputLimitKb = Math.floor(COMMAND_OUTPUT_LIMIT_BYTES / 1024);
      const stdoutText = result.stdout && result.stdout.length > 0 ? result.stdout : i18n.t('commandNoOutput');
      const stderrText = result.stderr && result.stderr.length > 0 ? result.stderr : i18n.t('commandNoOutput');
      const codeText = result.code === null ? 'null' : String(result.code);
      const lines = [
        `${i18n.t('commandHost')}: ${host}`,
        `$ ssh ${host} "${command}"`,
        '',
        `${i18n.t('commandStdout')}:`,
        stdoutText,
        '',
        `${i18n.t('commandStderr')}:`,
        stderrText,
        '',
        `${i18n.t('commandExitCode')}: ${codeText}`
      ];

      if (result.signal) {
        lines.push(`${i18n.t('commandSignal')}: ${result.signal}`);
      }
      if (result.error) {
        lines.push(`${i18n.t('commandSpawnError')}: ${result.error}`);
      }
      if (result.truncated) {
        lines.push('', i18n.t('commandOutputTruncated', { limitKb: outputLimitKb }));
      }

      return lines.join('\n');
    }

    function buildCopyIdReport(host, result) {
      const outputLimitKb = Math.floor(COMMAND_OUTPUT_LIMIT_BYTES / 1024);
      const stdoutText = result.stdout && result.stdout.length > 0 ? result.stdout : i18n.t('commandNoOutput');
      const stderrText = result.stderr && result.stderr.length > 0 ? result.stderr : i18n.t('commandNoOutput');
      const codeText = result.code === null ? 'null' : String(result.code);
      const lines = [
        `${i18n.t('commandHost')}: ${host}`,
        `$ ssh-copy-id ${host}`,
        '',
        `${i18n.t('commandStdout')}:`,
        stdoutText,
        '',
        `${i18n.t('commandStderr')}:`,
        stderrText,
        '',
        `${i18n.t('commandExitCode')}: ${codeText}`
      ];

      if (result.signal) {
        lines.push(`${i18n.t('commandSignal')}: ${result.signal}`);
      }
      if (result.error) {
        lines.push(`${i18n.t('copyIdSpawnError')}: ${result.error}`);
      }
      if (result.truncated) {
        lines.push('', i18n.t('commandOutputTruncated', { limitKb: outputLimitKb }));
      }

      return lines.join('\n');
    }

    function syncTunnelStatuses() {
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

    function renderHosts() {
      hostRows = hosts;
      if (!hostRows.length) {
        hostList.setItems([i18n.t('noHosts')]);
        return;
      }

      hostList.setItems(
        hostRows.map((host) =>
          formatHostTableRow(host, host.isPattern ? i18n.t('patternMark') : '')
        )
      );
    }

    function reloadHosts(preserveName = '') {
      const prevName = preserveName || (selectedHost() ? selectedHost().name : '');
      hosts = loadHostsFromConfig();
      renderHosts();
      if (!hosts.length) {
        return;
      }
      const nextIndex = Math.max(0, hosts.findIndex((item) => item.name === prevName));
      hostList.select(nextIndex);
    }

    function renderTunnels() {
      if (!Array.isArray(state.tunnels) || state.tunnels.length === 0) {
        tunnelList.setItems([i18n.t('noTunnels')]);
        return;
      }

      tunnelList.setItems(
        state.tunnels.map((tunnel) => {
          const statusText = markTunnelStatus(tunnel) === 'running' ? i18n.t('stateRunning') : i18n.t('stateStopped');
          const authText = tunnel.auth === 'password'
            ? i18n.t('authPassword')
            : (tunnel.auth === 'agent' ? i18n.t('authAgent') : i18n.t('authAuto'));
          return i18n.t('tunnelListFmt', {
            state: statusText,
            name: tunnel.name,
            type: tunnel.type,
            spec: tunnel.spec,
            host: tunnel.host,
            auth: authText,
            pid: tunnel.pid || '-'
          });
        })
      );
    }

    function rerenderAll() {
      i18n = createI18n(locale);
      hostList.setLabel(` ${i18n.t('hostPanel')} [${i18n.t('hostColumns')}] `);
      tunnelList.setLabel(` ${i18n.t('tunnelPanel')} `);
      status.style.border.fg = primaryColor;
      applyLayout();
      syncTunnelStatuses();
      renderHosts();
      renderTunnels();
      applyFocusStyles();
      setStatus(i18n.t('statusReady'));
    }

    async function addTunnelWizard() {
      const hostDefault = selectedHost() ? selectedHost().name : '';
      const form = {
        name: `tunnel-${Date.now()}`,
        type: 'L',
        host: hostDefault,
        localPort: null,
        remotePort: null,
        targetHost: '127.0.0.1',
        targetPort: null
      };
      let step = 'name';

      while (true) {
        if (step === 'name') {
          const value = await askAddStepInput(1, i18n.t('tunnelNamePrompt'), form.name, { allowBack: false });
          if (!value) {
            return;
          }
          form.name = value;
          step = 'type';
          continue;
        }

        if (step === 'type') {
          const value = await askAddStepInput(2, i18n.t('tunnelTypePrompt'), form.type, { allowBack: true });
          if (value === null) {
            return;
          }
          if (isDialogBack(value)) {
            step = 'name';
            continue;
          }
          const normalized = String(value).toUpperCase();
          if (!['L', 'R', 'D'].includes(normalized)) {
            setStatus(i18n.t('invalidInput'));
            continue;
          }
          form.type = normalized;
          step = 'host';
          continue;
        }

        if (step === 'host') {
          const value = await askAddStepInput(3, i18n.t('tunnelHostPrompt'), form.host, { allowBack: true });
          if (value === null) {
            return;
          }
          if (isDialogBack(value)) {
            step = 'type';
            continue;
          }
          form.host = value;
          step = form.type === 'L' ? 'lLocalPort' : (form.type === 'R' ? 'rRemotePort' : 'dLocalPort');
          continue;
        }

        if (step === 'lLocalPort') {
          const value = await askAddStepPort(4, i18n.t('tunnelLocalPortPrompt'), { allowBack: true });
          if (value === null) {
            return;
          }
          if (isDialogBack(value)) {
            step = 'host';
            continue;
          }
          form.localPort = value;
          step = 'lTargetHost';
          continue;
        }

        if (step === 'lTargetHost') {
          const value = await askAddStepInput(5, i18n.t('tunnelTargetHostPrompt'), form.targetHost, { allowBack: true });
          if (value === null) {
            return;
          }
          if (isDialogBack(value)) {
            step = 'lLocalPort';
            continue;
          }
          form.targetHost = value;
          step = 'lTargetPort';
          continue;
        }

        if (step === 'lTargetPort') {
          const value = await askAddStepPort(6, i18n.t('tunnelTargetPortPrompt'), { allowBack: true });
          if (value === null) {
            return;
          }
          if (isDialogBack(value)) {
            step = 'lTargetHost';
            continue;
          }
          form.targetPort = value;
          step = 'startNow';
          continue;
        }

        if (step === 'rRemotePort') {
          const value = await askAddStepPort(4, i18n.t('tunnelRemotePortPrompt'), { allowBack: true });
          if (value === null) {
            return;
          }
          if (isDialogBack(value)) {
            step = 'host';
            continue;
          }
          form.remotePort = value;
          step = 'rTargetHost';
          continue;
        }

        if (step === 'rTargetHost') {
          const value = await askAddStepInput(5, i18n.t('tunnelTargetHostPrompt'), form.targetHost, { allowBack: true });
          if (value === null) {
            return;
          }
          if (isDialogBack(value)) {
            step = 'rRemotePort';
            continue;
          }
          form.targetHost = value;
          step = 'rTargetPort';
          continue;
        }

        if (step === 'rTargetPort') {
          const value = await askAddStepPort(6, i18n.t('tunnelTargetPortPrompt'), { allowBack: true });
          if (value === null) {
            return;
          }
          if (isDialogBack(value)) {
            step = 'rTargetHost';
            continue;
          }
          form.targetPort = value;
          step = 'startNow';
          continue;
        }

        if (step === 'dLocalPort') {
          const value = await askAddStepPort(4, i18n.t('tunnelLocalPortPrompt'), { allowBack: true });
          if (value === null) {
            return;
          }
          if (isDialogBack(value)) {
            step = 'host';
            continue;
          }
          form.localPort = value;
          step = 'startNow';
          continue;
        }

        if (step === 'startNow') {
          const startNow = await askAddStepConfirm(7, `${i18n.t('tunnelCreated')}. Start now?`, { allowBack: true });
          if (startNow === null) {
            return;
          }
          if (isDialogBack(startNow)) {
            step = form.type === 'L' ? 'lTargetPort' : (form.type === 'R' ? 'rTargetPort' : 'dLocalPort');
            continue;
          }

          const config = {};
          if (form.type === 'L') {
            config.localPort = form.localPort;
            config.targetHost = form.targetHost;
            config.targetPort = form.targetPort;
          } else if (form.type === 'R') {
            config.remotePort = form.remotePort;
            config.targetHost = form.targetHost;
            config.targetPort = form.targetPort;
          } else {
            config.localPort = form.localPort;
          }

          const tunnel = {
            id: generateId(),
            name: form.name,
            type: form.type,
            host: form.host,
            spec: buildTunnelSpec(form.type, config),
            pid: null,
            auth: 'auto',
            createdAt: nowIso(),
            updatedAt: nowIso(),
            logFile: '',
            lastError: ''
          };

          state.tunnels.push(tunnel);
          saveState(state);
          renderTunnels();
          setStatus(i18n.t('tunnelCreated'));

          if (startNow) {
            tunnelList.select(state.tunnels.length - 1);
            await startSelectedTunnel();
          }
          return;
        }
      }
    }

    async function addHostWizard() {
      const form = {
        alias: '',
        hostName: '',
        user: '',
        port: '22'
      };
      let step = 'alias';

      while (true) {
        if (step === 'alias') {
          const value = await askAddHostStepInput(1, i18n.t('hostAliasPrompt'), form.alias, { allowBack: false });
          if (!value) {
            return;
          }
          form.alias = value;
          if (!form.hostName) {
            form.hostName = value;
          }
          step = 'hostName';
          continue;
        }

        if (step === 'hostName') {
          const value = await askAddHostStepInput(2, i18n.t('hostNamePrompt'), form.hostName, { allowBack: true });
          if (value === null) {
            return;
          }
          if (isDialogBack(value)) {
            step = 'alias';
            continue;
          }
          form.hostName = value;
          step = 'user';
          continue;
        }

        if (step === 'user') {
          const value = await askAddHostStepInput(3, i18n.t('hostUserPrompt'), form.user, { allowBack: true });
          if (value === null) {
            return;
          }
          if (isDialogBack(value)) {
            step = 'hostName';
            continue;
          }
          form.user = value;
          step = 'port';
          continue;
        }

        if (step === 'port') {
          const value = await askAddHostStepInput(4, i18n.t('hostPortPrompt'), form.port, { allowBack: true });
          if (value === null) {
            return;
          }
          if (isDialogBack(value)) {
            step = 'user';
            continue;
          }
          if (!isValidPort(value)) {
            setStatus(i18n.t('invalidInput'));
            continue;
          }
          form.port = value;
          addHostToConfig({
            alias: form.alias,
            hostName: form.hostName,
            user: form.user,
            port: Number(form.port)
          });
          reloadHosts(form.alias);
          setStatus(i18n.t('hostAdded'));
          return;
        }
      }
    }

    async function startSelectedTunnel() {
      const tunnel = selectedTunnel();
      if (!tunnel) {
        return;
      }

      if (tunnel.pid && isProcessAlive(tunnel.pid)) {
        setStatus(i18n.t('tunnelStarted'));
        return;
      }

      try {
        setStatus(i18n.t('tunnelStarting'));
        const activeLogFile = appendTunnelLog(
          tunnel,
          `Tunnel start requested: host=${tunnel.host} type=${tunnel.type} spec=${tunnel.spec}`
        );
        if (activeLogFile && tunnel.logFile !== activeLogFile) {
          tunnel.logFile = activeLogFile;
          saveState(state);
        }

        appendTunnelLog(tunnel, 'Checking SSH key authentication');
        setStatus(i18n.t('tunnelCheckingAuth'));
        let password = '';
        const keyProbe = await probeSshKeyAuth(tunnel.host);
        if (!keyProbe.ok) {
          appendTunnelLog(
            tunnel,
            `Key auth probe failed: authFailed=${keyProbe.authFailed} code=${keyProbe.code} signal=${keyProbe.signal} error=${keyProbe.error || '-'}`
          );
          const probeDetails = (keyProbe.stderr || keyProbe.stdout || keyProbe.error || '').trim();
          if (probeDetails) {
            appendTunnelLog(tunnel, `Key auth probe details: ${probeDetails}`);
          }
          if (!keyProbe.authFailed) {
            throw new Error(probeDetails || 'Unable to verify key authentication');
          }
          appendTunnelLog(tunnel, 'Falling back to password prompt');
          setStatus(i18n.t('tunnelWaitingPassword'));
          const entered = await askSecretModal(i18n.t('tunnelPasswordPrompt'));
          if (!entered) {
            appendTunnelLog(tunnel, 'Password prompt cancelled by user');
            return;
          }
          password = entered;
          appendTunnelLog(tunnel, 'Password entered, starting tunnel with password auth');
        } else {
          appendTunnelLog(tunnel, 'Key auth probe succeeded, starting tunnel with key/agent auth');
        }

        const started = await startTunnel(tunnel, password);
        appendTunnelLog(tunnel, `Tunnel started successfully (pid=${started.pid})`);
        tunnel.pid = started.pid;
        tunnel.logFile = started.logFile;
        tunnel.updatedAt = started.updatedAt;
        tunnel.lastError = '';
        saveState(state);
        renderTunnels();
        setStatus(i18n.t('tunnelStarted'));
      } catch (error) {
        appendTunnelLog(tunnel, `Tunnel start failed: ${error.message}`);
        tunnel.lastError = error.message;
        saveState(state);
        setStatus(`${i18n.t('tunnelStartFailed')}: ${error.message}`);
      }
    }

    async function stopSelectedTunnel() {
      const tunnel = selectedTunnel();
      if (!tunnel) {
        return;
      }

      if (!tunnel.pid) {
        setStatus(i18n.t('tunnelStopped'));
        return;
      }

      try {
        stopTunnel(tunnel.pid);
        tunnel.pid = null;
        tunnel.updatedAt = nowIso();
        saveState(state);
        renderTunnels();
        setStatus(i18n.t('tunnelStopped'));
      } catch (error) {
        setStatus(`${i18n.t('tunnelStopFailed')}: ${error.message}`);
      }
    }

    async function deleteSelectedTunnel() {
      const tunnel = selectedTunnel();
      if (!tunnel) {
        return;
      }

      const confirm = await askYesNoModal(i18n.t('confirmDelete'), {
        dialogLabel: i18n.t('deleteDialogTitle'),
        yesLabel: i18n.t('btnDelete'),
        noLabel: i18n.t('btnCancel')
      });
      if (!confirm) {
        return;
      }

      if (tunnel.pid && isProcessAlive(tunnel.pid)) {
        try {
          stopTunnel(tunnel.pid);
        } catch (error) {
          setStatus(`${i18n.t('tunnelStopFailed')}: ${error.message}`);
          return;
        }
      }

      state.tunnels = state.tunnels.filter((item) => item.id !== tunnel.id);
      saveState(state);
      renderTunnels();
      setStatus(i18n.t('tunnelDeleted'));
    }

    async function deleteSelectedHost() {
      const host = selectedHost();
      if (!host) {
        setStatus(i18n.t('noHosts'));
        return;
      }

      const confirm = await askYesNoModal(i18n.t('confirmDeleteHost', { host: host.name }), {
        dialogLabel: i18n.t('deleteHostDialogTitle'),
        yesLabel: i18n.t('btnDelete'),
        noLabel: i18n.t('btnCancel')
      });
      if (!confirm) {
        return;
      }

      deleteHostFromConfig(host.name, host.source || undefined);
      reloadHosts();
      setStatus(i18n.t('hostDeleted'));
    }

    async function connectSelectedHost() {
      const host = selectedHost();
      if (!host) {
        setStatus(i18n.t('noHosts'));
        return;
      }

      let target = host.name;
      if (host.isPattern) {
        const concrete = await askTextModal(i18n.t('connectPromptPattern'));
        if (!concrete) {
          return;
        }
        target = concrete;
      }

      finalize({ type: 'connect', host: target });
    }

    async function resolveCommandTarget() {
      if (focusLeft) {
        const host = selectedHost();
        if (!host) {
          setStatus(i18n.t('noHosts'));
          return null;
        }
        if (host.isPattern) {
          const concrete = await askTextModal(i18n.t('connectPromptPattern'));
          if (!concrete) {
            return null;
          }
          return { host: concrete, usePassword: false };
        }
        return { host: host.name, usePassword: false };
      }

      const tunnel = selectedTunnel();
      if (tunnel && tunnel.host) {
        return { host: tunnel.host, usePassword: tunnel.auth === 'password' };
      }

      const host = selectedHost();
      if (!host) {
        setStatus(i18n.t('noHosts'));
        return null;
      }
      if (host.isPattern) {
        const concrete = await askTextModal(i18n.t('connectPromptPattern'));
        if (!concrete) {
          return null;
        }
        return { host: concrete, usePassword: false };
      }
      return { host: host.name, usePassword: false };
    }

    async function runCommandAndShowOutput() {
      const target = await resolveCommandTarget();
      if (!target || !target.host) {
        return;
      }
      const host = target.host;

      const command = await askTextModal(i18n.t('commandPrompt'), '', {
        dialogLabel: i18n.t('runCommandDialogTitle')
      });
      if (!command) {
        return;
      }

      let password = '';
      if (target.usePassword) {
        const entered = await askSecretModal(i18n.t('tunnelPasswordPrompt'), {
          dialogLabel: i18n.t('runCommandDialogTitle')
        });
        if (!entered) {
          return;
        }
        password = entered;
      }

      setStatus(i18n.t('commandRunning', { host, command }));
      const result = await runSshCommand(host, command, {
        outputLimitBytes: COMMAND_OUTPUT_LIMIT_BYTES,
        password
      });
      await showOutputModal(buildCommandReport(host, command, result), {
        dialogLabel: i18n.t('commandOutputTitle'),
        hintText: i18n.t('commandOutputHint')
      });

      const statusCode = result.code === null
        ? (result.signal ? `signal:${result.signal}` : 'null')
        : String(result.code);
      setStatus(i18n.t('commandFinished', { host, code: statusCode }));

      if (focusLeft) {
        hostList.focus();
      } else {
        tunnelList.focus();
      }
    }

    async function runCopyIdAndShowOutput() {
      const target = await resolveCommandTarget();
      if (!target || !target.host) {
        return;
      }
      const host = target.host;

      let password = '';
      let usePassword = Boolean(target.usePassword);
      if (!usePassword) {
        usePassword = await askYesNoModal(i18n.t('copyIdUsePasswordPrompt'), {
          dialogLabel: i18n.t('copyIdDialogTitle')
        });
      }

      if (usePassword) {
        const entered = await askSecretModal(i18n.t('tunnelPasswordPrompt'), {
          dialogLabel: i18n.t('copyIdDialogTitle')
        });
        if (!entered) {
          return;
        }
        password = entered;
      }

      setStatus(i18n.t('copyIdRunning', { host }));
      const result = await runSshCopyId(host, {
        outputLimitBytes: COMMAND_OUTPUT_LIMIT_BYTES,
        password
      });
      await showOutputModal(buildCopyIdReport(host, result), {
        dialogLabel: i18n.t('copyIdOutputTitle'),
        hintText: i18n.t('commandOutputHint')
      });

      const statusCode = result.code === null
        ? (result.signal ? `signal:${result.signal}` : 'null')
        : String(result.code);
      setStatus(i18n.t('copyIdFinished', { host, code: statusCode }));

      if (focusLeft) {
        hostList.focus();
      } else {
        tunnelList.focus();
      }
    }

    async function exportConfigFlow() {
      const entered = await askTextModal(
        i18n.t('configExportPathPrompt'),
        defaultConfigExportPath(),
        { dialogLabel: i18n.t('configExportDialogTitle') }
      );
      if (!entered) {
        return;
      }

      const targetPath = resolveUserPath(entered);
      if (!targetPath) {
        setStatus(i18n.t('invalidInput'));
        return;
      }

      exportConfigToFile(state, targetPath);
      setStatus(i18n.t('configExported', { path: targetPath }));
    }

    async function importConfigFlow() {
      const entered = await askTextModal(
        i18n.t('configImportPathPrompt'),
        path.join(STATE_DIR, 'config-export.json'),
        { dialogLabel: i18n.t('configImportDialogTitle') }
      );
      if (!entered) {
        return;
      }

      const sourcePath = resolveUserPath(entered);
      if (!sourcePath) {
        setStatus(i18n.t('invalidInput'));
        return;
      }

      const confirm = await askYesNoModal(
        i18n.t('configImportConfirm', { path: sourcePath }),
        {
          dialogLabel: i18n.t('configImportDialogTitle'),
          yesLabel: i18n.t('yes'),
          noLabel: i18n.t('no')
        }
      );
      if (!confirm) {
        return;
      }

      const imported = importConfigFromFile(sourcePath);
      state.version = imported.version;
      state.locale = imported.locale;
      state.accentColor = normalizeAccentColor(imported.accentColor);
      state.tunnels = imported.tunnels;
      saveState(state);

      locale = state.locale || locale;
      primaryColor = normalizeAccentColor(state.accentColor);
      rerenderAll();
      applyFocusStyles();
      if (focusLeft) {
        hostList.focus();
      } else {
        tunnelList.focus();
      }
      setStatus(i18n.t('configImported', { path: sourcePath }));
    }

    async function showSettingsMenu() {
      beginModal();
      try {
        return await new Promise((resolve) => {
          const box = blessed.box({
            parent: screen,
            border: 'line',
            label: ` ${i18n.t('settingsMenuTitle')} `,
            width: '60%',
            height: 14,
            top: 'center',
            left: 'center',
            keys: true,
            mouse: true,
            style: {
              border: { fg: primaryColor, bg: DIALOG_BG },
              bg: DIALOG_BG,
              fg: DIALOG_FG
            }
          });

          const hint = blessed.text({
            parent: box,
            top: 1,
            left: 2,
            content: i18n.t('settingsMenuHint'),
            style: {
              bg: DIALOG_BG,
              fg: DIALOG_FG
            }
          });

          const items = [
            { key: 'language', title: i18n.t('settingsItemLanguage') },
            { key: 'accent', title: i18n.t('settingsItemAccent') },
            { key: 'import', title: i18n.t('settingsItemImport') },
            { key: 'export', title: i18n.t('settingsItemExport') },
            { key: 'reload', title: i18n.t('settingsItemReload') }
          ];

          const list = blessed.list({
            parent: box,
            border: 'line',
            top: 3,
            left: 2,
            height: 6,
            keys: false,
            vi: false,
            loop: true,
            mouse: true,
            items: items.map((item, idx) => `${idx + 1}. ${item.title}`),
            style: {
              selected: { bg: primaryColor, fg: 'black' },
              border: { fg: 'white', bg: DIALOG_BG },
              bg: DIALOG_BG,
              fg: DIALOG_FG
            }
          });

          const closeBtn = createDialogButton(box, 0, i18n.t('btnClose'));
          const applySettingsLayout = () => {
            hint.left = 2;
            hint.right = 2;
            hint.width = undefined;
            list.left = 2;
            list.right = 2;
            list.width = undefined;
            closeBtn.top = 10;
            closeBtn.left = 2;
            closeBtn.right = 2;
            closeBtn.width = undefined;
          };
          const onSettingsResize = () => {
            if (box.detached) {
              return;
            }
            applySettingsLayout();
            screen.render();
          };
          screen.on('resize', onSettingsResize);
          box.on('destroy', () => {
            if (typeof screen.off === 'function') {
              screen.off('resize', onSettingsResize);
              return;
            }
            screen.removeListener('resize', onSettingsResize);
          });
          applySettingsLayout();

          let done = false;
          let active = 'list';

          function finish(value) {
            if (done) {
              return;
            }
            done = true;
            box.destroy();
            screen.render();
            resolve(value);
          }

          function setActive(nextActive) {
            active = nextActive;
            list.style.border.fg = active === 'list' ? primaryColor : 'white';
            styleDialogButton(closeBtn, active === 'close');
            screen.render();
          }

          function moveListSelection(delta) {
            if (!items.length) {
              return;
            }
            const current = Number.isInteger(list.selected) ? list.selected : 0;
            const safeCurrent = Math.max(0, Math.min(current, items.length - 1));
            const next = (safeCurrent + delta + items.length) % items.length;
            list.select(next);
            screen.render();
          }

          function selectedKey() {
            const idx = Math.max(0, Math.min(items.length - 1, list.selected));
            return items[idx].key;
          }

          function handleSelect() {
            finish(selectedKey());
          }

          function cycleForward() {
            if (active === 'list') {
              setActive('close');
            } else {
              setActive('list');
            }
          }

          function cycleBackward() {
            if (active === 'list') {
              setActive('close');
            } else {
              setActive('list');
            }
          }

          function handleKey(ch, key) {
            if (done) {
              return;
            }
            if (key && key.full === 'C-c') {
              return;
            }
            if (key && key.name === 'escape') {
              finish(null);
              return;
            }
            if (key && key.name === 'tab') {
              cycleForward();
              return;
            }
            if (key && key.name === 'S-tab') {
              cycleBackward();
              return;
            }

            if (key && key.name === 'enter') {
              if (active === 'close') {
                finish(null);
                return;
              }
              handleSelect();
              return;
            }

            if (active === 'list' && key && (key.name === 'up' || key.name === 'k')) {
              moveListSelection(-1);
              return;
            }
            if (active === 'list' && key && (key.name === 'down' || key.name === 'j')) {
              moveListSelection(1);
              return;
            }

            if (ch && /^\d$/.test(ch)) {
              const numeric = Number(ch);
              if (numeric >= 1 && numeric <= items.length) {
                list.select(numeric - 1);
                handleSelect();
              }
            }
          }

          box.on('keypress', handleKey);
          list.on('keypress', handleKey);
          closeBtn.on('keypress', handleKey);

          list.on('click', () => {
            setActive('list');
          });
          closeBtn.on('click', () => {
            setActive('close');
            finish(null);
          });

          box.focus();
          list.focus();
          list.select(0);
          setActive('list');
        });
      } finally {
        endModal();
      }
    }

    function applyReload() {
      finalize({ type: 'reload' });
    }

    function formatLocaleLabel(code) {
      const meta = getLocaleMeta(code);
      if (meta.nativeName && meta.name && meta.nativeName !== meta.name) {
        return `${meta.nativeName} (${meta.name})`;
      }
      return meta.nativeName || meta.name || code;
    }

    function formatAccentColorLabel(code) {
      return i18n.t(`accentColor.${code}`);
    }

    async function showLanguageMenu() {
      beginModal();
      try {
        return await new Promise((resolve) => {
          const available = getAvailableLocales();
          const box = blessed.box({
            parent: screen,
            border: 'line',
            width: '60%',
            height: 14,
            top: 'center',
            left: 'center',
            keys: true,
            mouse: true,
            style: {
              border: { fg: primaryColor, bg: DIALOG_BG },
              bg: DIALOG_BG,
              fg: DIALOG_FG
            }
          });
          createDialogTitleBadge(box, i18n.t('languageMenuTitle'));

          const hint = blessed.text({
            parent: box,
            top: 1,
            left: 2,
            content: i18n.t('languageMenuHint'),
            style: {
              bg: DIALOG_BG,
              fg: DIALOG_FG
            }
          });

          const items = available.map((code, idx) => ({
            key: code,
            title: `${idx + 1}. ${formatLocaleLabel(code)}`
          }));

          const list = blessed.list({
            parent: box,
            border: 'line',
            top: 3,
            left: 2,
            height: 6,
            keys: false,
            vi: false,
            loop: true,
            mouse: true,
            items: items.map((item) => item.title),
            style: {
              selected: { bg: primaryColor, fg: 'black' },
              border: { fg: 'white', bg: DIALOG_BG },
              bg: DIALOG_BG,
              fg: DIALOG_FG
            }
          });

          const closeBtn = createDialogButton(box, 0, i18n.t('btnClose'));
          const applyLanguageLayout = () => {
            hint.left = 2;
            hint.right = 2;
            hint.width = undefined;
            list.left = 2;
            list.right = 2;
            list.width = undefined;
            closeBtn.top = 10;
            closeBtn.left = 2;
            closeBtn.right = 2;
            closeBtn.width = undefined;
          };
          const onLanguageResize = () => {
            if (box.detached) {
              return;
            }
            applyLanguageLayout();
            screen.render();
          };
          screen.on('resize', onLanguageResize);
          box.on('destroy', () => {
            if (typeof screen.off === 'function') {
              screen.off('resize', onLanguageResize);
              return;
            }
            screen.removeListener('resize', onLanguageResize);
          });
          applyLanguageLayout();

          let done = false;
          let active = 'list';

          function finish(value) {
            if (done) {
              return;
            }
            done = true;
            box.destroy();
            screen.render();
            resolve(value);
          }

          function setActive(nextActive) {
            active = nextActive;
            list.style.border.fg = active === 'list' ? primaryColor : 'white';
            styleDialogButton(closeBtn, active === 'close');
            screen.render();
          }

          function moveListSelection(delta) {
            if (!items.length) {
              return;
            }
            const current = Number.isInteger(list.selected) ? list.selected : 0;
            const safeCurrent = Math.max(0, Math.min(current, items.length - 1));
            const next = (safeCurrent + delta + items.length) % items.length;
            list.select(next);
            screen.render();
          }

          function selectedLocale() {
            const idx = Math.max(0, Math.min(items.length - 1, list.selected));
            return items[idx].key;
          }

          function cycleFocus() {
            if (active === 'list') {
              setActive('close');
            } else {
              setActive('list');
            }
          }

          function handleKey(ch, key) {
            if (done) {
              return;
            }
            if (key && key.full === 'C-c') {
              return;
            }
            if (key && key.name === 'escape') {
              finish(null);
              return;
            }
            if (key && (key.name === 'tab' || key.name === 'S-tab')) {
              cycleFocus();
              return;
            }

            if (key && key.name === 'enter') {
              if (active === 'close') {
                finish(null);
                return;
              }
              finish(selectedLocale());
              return;
            }

            if (active === 'list' && key && (key.name === 'up' || key.name === 'k')) {
              moveListSelection(-1);
              return;
            }
            if (active === 'list' && key && (key.name === 'down' || key.name === 'j')) {
              moveListSelection(1);
              return;
            }

            if (ch && /^\d$/.test(ch)) {
              const numeric = Number(ch);
              if (numeric >= 1 && numeric <= items.length) {
                list.select(numeric - 1);
                finish(selectedLocale());
              }
            }
          }

          box.on('keypress', handleKey);
          list.on('keypress', handleKey);
          closeBtn.on('keypress', handleKey);
          list.on('click', () => setActive('list'));
          closeBtn.on('click', () => {
            setActive('close');
            finish(null);
          });

          box.focus();
          list.focus();
          const currentIdx = Math.max(0, available.indexOf(locale));
          list.select(currentIdx);
          setActive('list');
        });
      } finally {
        endModal();
      }
    }

    async function openLanguageMenuFlow() {
      const selected = await showLanguageMenu();
      if (!selected || selected === locale) {
        return;
      }
      locale = selected;
      state.locale = locale;
      saveState(state);
      rerenderAll();
      setStatus(i18n.t('languageSet', { lang: formatLocaleLabel(locale) }));
    }

    async function showAccentColorMenu() {
      beginModal();
      try {
        return await new Promise((resolve) => {
          const available = ACCENT_COLOR_OPTIONS;
          const box = blessed.box({
            parent: screen,
            border: 'line',
            width: '60%',
            height: 14,
            top: 'center',
            left: 'center',
            keys: true,
            mouse: true,
            style: {
              border: { fg: primaryColor, bg: DIALOG_BG },
              bg: DIALOG_BG,
              fg: DIALOG_FG
            }
          });
          createDialogTitleBadge(box, i18n.t('accentMenuTitle'));

          const hint = blessed.text({
            parent: box,
            top: 1,
            left: 2,
            content: i18n.t('accentMenuHint'),
            style: {
              bg: DIALOG_BG,
              fg: DIALOG_FG
            }
          });

          const items = available.map((code, idx) => ({
            key: code,
            title: `${idx + 1}. ${formatAccentColorLabel(code)}`
          }));

          const list = blessed.list({
            parent: box,
            border: 'line',
            top: 3,
            left: 2,
            height: 6,
            keys: false,
            vi: false,
            loop: true,
            mouse: true,
            items: items.map((item) => item.title),
            style: {
              selected: { bg: primaryColor, fg: 'black' },
              border: { fg: 'white', bg: DIALOG_BG },
              bg: DIALOG_BG,
              fg: DIALOG_FG
            }
          });

          const closeBtn = createDialogButton(box, 0, i18n.t('btnClose'));
          const applyAccentLayout = () => {
            hint.left = 2;
            hint.right = 2;
            hint.width = undefined;
            list.left = 2;
            list.right = 2;
            list.width = undefined;
            closeBtn.top = 10;
            closeBtn.left = 2;
            closeBtn.right = 2;
            closeBtn.width = undefined;
          };
          const onAccentResize = () => {
            if (box.detached) {
              return;
            }
            applyAccentLayout();
            screen.render();
          };
          screen.on('resize', onAccentResize);
          box.on('destroy', () => {
            if (typeof screen.off === 'function') {
              screen.off('resize', onAccentResize);
              return;
            }
            screen.removeListener('resize', onAccentResize);
          });
          applyAccentLayout();

          let done = false;
          let active = 'list';

          function finish(value) {
            if (done) {
              return;
            }
            done = true;
            box.destroy();
            screen.render();
            resolve(value);
          }

          function setActive(nextActive) {
            active = nextActive;
            list.style.border.fg = active === 'list' ? primaryColor : 'white';
            styleDialogButton(closeBtn, active === 'close');
            screen.render();
          }

          function moveListSelection(delta) {
            if (!items.length) {
              return;
            }
            const current = Number.isInteger(list.selected) ? list.selected : 0;
            const safeCurrent = Math.max(0, Math.min(current, items.length - 1));
            const next = (safeCurrent + delta + items.length) % items.length;
            list.select(next);
            screen.render();
          }

          function selectedColor() {
            const idx = Math.max(0, Math.min(items.length - 1, list.selected));
            return items[idx].key;
          }

          function cycleFocus() {
            if (active === 'list') {
              setActive('close');
            } else {
              setActive('list');
            }
          }

          function handleKey(ch, key) {
            if (done) {
              return;
            }
            if (key && key.full === 'C-c') {
              return;
            }
            if (key && key.name === 'escape') {
              finish(null);
              return;
            }
            if (key && (key.name === 'tab' || key.name === 'S-tab')) {
              cycleFocus();
              return;
            }
            if (key && key.name === 'enter') {
              if (active === 'close') {
                finish(null);
                return;
              }
              finish(selectedColor());
              return;
            }

            if (active === 'list' && key && (key.name === 'up' || key.name === 'k')) {
              moveListSelection(-1);
              return;
            }
            if (active === 'list' && key && (key.name === 'down' || key.name === 'j')) {
              moveListSelection(1);
              return;
            }
            if (ch && /^\d$/.test(ch)) {
              const numeric = Number(ch);
              if (numeric >= 1 && numeric <= items.length) {
                list.select(numeric - 1);
                finish(selectedColor());
              }
            }
          }

          box.on('keypress', handleKey);
          list.on('keypress', handleKey);
          closeBtn.on('keypress', handleKey);
          list.on('click', () => setActive('list'));
          closeBtn.on('click', () => {
            setActive('close');
            finish(null);
          });

          box.focus();
          list.focus();
          const currentIdx = Math.max(0, available.indexOf(primaryColor));
          list.select(currentIdx);
          setActive('list');
        });
      } finally {
        endModal();
      }
    }

    async function openAccentColorMenuFlow() {
      const selected = await showAccentColorMenu();
      if (!selected || selected === primaryColor) {
        return;
      }
      primaryColor = normalizeAccentColor(selected);
      state.accentColor = primaryColor;
      saveState(state);
      rerenderAll();
      setStatus(i18n.t('accentSet', { color: formatAccentColorLabel(primaryColor) }));
    }

    async function openSettingsMenuFlow() {
      try {
        const choice = await showSettingsMenu();
        if (!choice) {
          return;
        }
        if (choice === 'language') {
          await openLanguageMenuFlow();
          return;
        }
        if (choice === 'accent') {
          await openAccentColorMenuFlow();
          return;
        }
        if (choice === 'import') {
          await importConfigFlow();
          return;
        }
        if (choice === 'export') {
          await exportConfigFlow();
          return;
        }
        if (choice === 'reload') {
          applyReload();
        }
      } finally {
        if (!closing) {
          if (focusLeft) {
            hostList.focus();
          } else {
            tunnelList.focus();
          }
          applyFocusStyles();
          screen.render();
        }
      }
    }

    async function openShortcutsHelpFlow() {
      await showOutputModal(i18n.t('shortcutsHelpBody'), {
        dialogLabel: i18n.t('shortcutsHelpTitle'),
        hintText: i18n.t('shortcutsHelpHint'),
        closeOnF1: true
      });
    }

    async function toggleSelectedTunnelState() {
      const tunnel = selectedTunnel();
      if (!tunnel) {
        return;
      }
      if (tunnel.pid && isProcessAlive(tunnel.pid)) {
        await stopSelectedTunnel();
        return;
      }
      await startSelectedTunnel();
    }

    async function safeUiAction(handler) {
      try {
        await handler();
      } catch (error) {
        setStatus(error && error.message ? error.message : 'Unexpected error');
      }
      if (!closing) {
        screen.render();
      }
    }

    function switchFocus() {
      focusLeft = !focusLeft;
      if (focusLeft) {
        hostList.focus();
      } else {
        tunnelList.focus();
      }
      applyFocusStyles();
      screen.render();
    }

    function getFocusedListAndCount() {
      if (focusLeft) {
        return { list: hostList, count: hostRows.length };
      }
      return { list: tunnelList, count: Array.isArray(state.tunnels) ? state.tunnels.length : 0 };
    }

    function moveFocusedSelection(delta) {
      const { list, count } = getFocusedListAndCount();
      if (!count) {
        return;
      }
      const current = Number.isInteger(list.selected) ? list.selected : 0;
      const safeCurrent = Math.max(0, Math.min(current, count - 1));
      const next = (safeCurrent + delta + count) % count;
      list.select(next);
      screen.render();
    }

    function applyFocusStyles() {
      const inactiveColor = 'white';
      hostList.style.border.fg = focusLeft ? primaryColor : inactiveColor;
      tunnelList.style.border.fg = focusLeft ? inactiveColor : primaryColor;
      hostList.style.selected.bg = focusLeft ? primaryColor : 'white';
      hostList.style.selected.fg = 'black';
      tunnelList.style.selected.bg = focusLeft ? 'white' : primaryColor;
      tunnelList.style.selected.fg = 'black';
    }

    screen.key(['q', 'й', 'Q', 'Й', 'C-c'], () => {
      finalize({ type: 'quit' });
    });

    screen.on('resize', () => {
      applyLayout();
      screen.render();
    });

    screen.key(['tab'], () => switchFocus());
    screen.key(['up', 'k'], () => moveFocusedSelection(-1));
    screen.key(['down', 'j'], () => moveFocusedSelection(1));
    screen.key(['h', 'р', 'H', 'Р'], () => {
      focusLeft = true;
      hostList.focus();
      applyFocusStyles();
      screen.render();
    });
    screen.key(['t', 'е', 'T', 'Е'], () => {
      focusLeft = false;
      tunnelList.focus();
      applyFocusStyles();
      screen.render();
    });

    screen.key(['e', 'у', 'E', 'У'], () => safeUiAction(runCommandAndShowOutput));
    screen.key(['i', 'ш', 'I', 'Ш'], () => safeUiAction(runCopyIdAndShowOutput));
    screen.key(['m', 'ь', 'M', 'Ь'], () => safeUiAction(openSettingsMenuFlow));
    screen.key(['f1', '?'], () => safeUiAction(openShortcutsHelpFlow));

    screen.key(['a', 'ф', 'A', 'Ф'], () => safeUiAction(async () => {
      if (focusLeft) {
        await addHostWizard();
        return;
      }
      await addTunnelWizard();
    }));
    screen.key(['s', 'ы', 'S', 'Ы'], () => safeUiAction(startSelectedTunnel));
    screen.key(['x', 'ч', 'X', 'Ч'], () => safeUiAction(stopSelectedTunnel));
    screen.key(['d', 'в', 'D', 'В', 'delete'], () => safeUiAction(async () => {
      if (focusLeft) {
        await deleteSelectedHost();
        return;
      }
      await deleteSelectedTunnel();
    }));
    screen.key(['enter'], () => safeUiAction(async () => {
      if (focusLeft) {
        await connectSelectedHost();
        return;
      }
      await toggleSelectedTunnelState();
    }));

    screen.key(['c', 'с', 'C', 'С'], () => safeUiAction(async () => {
      await connectSelectedHost();
    }));

    syncTunnelStatuses();
    applyLayout();
    renderHosts();
    renderTunnels();
    applyFocusStyles();
    hostList.focus();
    screen.render();
  });
}

module.exports = {
  runTui
};
