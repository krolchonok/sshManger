'use strict';

const path = require('path');
const blessed = require('blessed');
const { createI18n, nextLocale } = require('./i18n');
const { startTunnel, stopTunnel, isProcessAlive, buildTunnelSpec, runSshCommand, runSshCopyId } = require('./ssh');
const { loadHostsFromConfig, addHostToConfig, deleteHostFromConfig } = require('./sshConfig');
const { nowIso, exportConfigToFile, importConfigFromFile } = require('./state');
const { HOME_DIR, STATE_DIR } = require('./paths');

const PRIMARY_COLOR = 'green';
const DIALOG_BG = 'black';
const DIALOG_FG = 'white';
const DIALOG_ACTIVE_FG = PRIMARY_COLOR;
const BUTTON_MIN_WIDTH = 12;
const BUTTON_BG = 'white';
const BUTTON_BG_ACTIVE = PRIMARY_COLOR;
const BUTTON_FG = 'black';
const BUTTON_FG_ACTIVE = 'black';
const DIALOG_BACK = '__dialog_back__';
const COMMAND_OUTPUT_LIMIT_BYTES = 200 * 1024;

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
  button.style.bg = isActive ? BUTTON_BG_ACTIVE : BUTTON_BG;
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
      hover: { fg: BUTTON_FG_ACTIVE, bg: BUTTON_BG_ACTIVE }
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
        border: { fg: PRIMARY_COLOR, bg: DIALOG_BG },
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
        border: { fg: PRIMARY_COLOR, bg: DIALOG_BG },
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
        border: { fg: PRIMARY_COLOR, bg: DIALOG_BG },
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
      inputFrame.style.border.fg = active === 'input' ? PRIMARY_COLOR : 'white';
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
        border: { fg: PRIMARY_COLOR, bg: DIALOG_BG },
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
      inputFrame.style.border.fg = active === 'input' ? PRIMARY_COLOR : 'white';
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
  const localeEnv = `${process.env.LC_ALL || ''} ${process.env.LC_CTYPE || ''} ${process.env.LANG || ''}`;
  const isUtf8 = /UTF-?8/i.test(localeEnv);
  let locale = state.locale || 'en';
  if (!isUtf8) {
    locale = 'en';
  }
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

    const title = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      height: 1,
      width: '100%',
      align: 'center',
      content: i18n.t('appTitle'),
      style: { fg: PRIMARY_COLOR }
    });

    const hostList = blessed.list({
      parent: screen,
      label: ` ${i18n.t('hostPanel')} [${i18n.t('hostColumns')}] `,
      border: 'line',
      top: 1,
      left: 0,
      width: '50%',
      height: 10,
      keys: true,
      vi: true,
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
      top: 1,
      left: '50%',
      width: '50%',
      height: 10,
      keys: true,
      vi: true,
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
      top: 11,
      height: 3,
      left: 0,
      width: '100%',
      content: `${i18n.t('statusPrefix')}${i18n.t('statusReady')}`,
      style: { border: { fg: PRIMARY_COLOR } }
    });

    const footer = blessed.box({
      parent: screen,
      top: 14,
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
          hintText: options.hintText || i18n.t('commandOutputHint')
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
      const titleHeight = 1;
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
      footer.setContent(i18n.t(compact ? 'footerKeysCompact' : 'footerKeys'));
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
          const authText = tunnel.auth === 'password' ? i18n.t('authPassword') : i18n.t('authAgent');
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
      title.setContent(i18n.t('appTitle'));
      hostList.setLabel(` ${i18n.t('hostPanel')} [${i18n.t('hostColumns')}] `);
      tunnelList.setLabel(` ${i18n.t('tunnelPanel')} `);
      applyLayout();
      syncTunnelStatuses();
      renderHosts();
      renderTunnels();
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
        targetPort: null,
        usePassword: false
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
          step = 'auth';
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
          step = 'auth';
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
          step = 'auth';
          continue;
        }

        if (step === 'auth') {
          const value = await askAddStepConfirm(7, i18n.t('tunnelAuthPrompt'), { allowBack: true });
          if (value === null) {
            return;
          }
          if (isDialogBack(value)) {
            step = form.type === 'L' ? 'lTargetPort' : (form.type === 'R' ? 'rTargetPort' : 'dLocalPort');
            continue;
          }
          form.usePassword = Boolean(value);
          step = 'startNow';
          continue;
        }

        if (step === 'startNow') {
          const startNow = await askAddStepConfirm(8, `${i18n.t('tunnelCreated')}. Start now?`, { allowBack: true });
          if (startNow === null) {
            return;
          }
          if (isDialogBack(startNow)) {
            step = 'auth';
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
            auth: form.usePassword ? 'password' : 'agent',
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

      let password = null;
      if (tunnel.auth === 'password') {
        password = await askSecretModal(i18n.t('tunnelPasswordPrompt'));
        if (!password) {
          return;
        }
      }

      try {
        const started = await startTunnel(tunnel, password);
        tunnel.pid = started.pid;
        tunnel.logFile = started.logFile;
        tunnel.updatedAt = started.updatedAt;
        tunnel.lastError = '';
        saveState(state);
        renderTunnels();
        setStatus(i18n.t('tunnelStarted'));
      } catch (error) {
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
      state.tunnels = imported.tunnels;
      saveState(state);

      locale = state.locale || locale;
      rerenderAll();
      applyFocusStyles();
      if (focusLeft) {
        hostList.focus();
      } else {
        tunnelList.focus();
      }
      setStatus(i18n.t('configImported', { path: sourcePath }));
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

    function applyFocusStyles() {
      const inactiveColor = 'white';
      hostList.style.border.fg = focusLeft ? PRIMARY_COLOR : inactiveColor;
      tunnelList.style.border.fg = focusLeft ? inactiveColor : PRIMARY_COLOR;
      hostList.style.selected.bg = focusLeft ? PRIMARY_COLOR : 'white';
      hostList.style.selected.fg = 'black';
      tunnelList.style.selected.bg = focusLeft ? 'white' : PRIMARY_COLOR;
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

    screen.key(['l', 'д', 'L', 'Д'], () => {
      locale = nextLocale(locale);
      state.locale = locale;
      saveState(state);
      rerenderAll();
      setStatus(i18n.t('languageSet', { lang: locale }));
    });

    screen.key(['r', 'к', 'R', 'К'], () => {
      finalize({ type: 'reload' });
    });

    screen.key(['e', 'у', 'E', 'У'], () => safeUiAction(runCommandAndShowOutput));
    screen.key(['i', 'ш', 'I', 'Ш'], () => safeUiAction(runCopyIdAndShowOutput));
    screen.key(['o', 'щ', 'O', 'Щ'], () => safeUiAction(exportConfigFlow));
    screen.key(['p', 'з', 'P', 'З'], () => safeUiAction(importConfigFlow));

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
    screen.key(['c', 'с', 'C', 'С', 'enter'], () => safeUiAction(async () => {
      if (!focusLeft) {
        return;
      }
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
