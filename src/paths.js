'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME_DIR = os.homedir();
const STATE_DIR = path.join(HOME_DIR, '.sshhelper');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOG_DIR = path.join(STATE_DIR, 'logs');
const ASKPASS_DIR = path.join(STATE_DIR, 'askpass');
const SSH_CONFIG_PATH = path.join(HOME_DIR, '.ssh', 'config');

function ensureDirs() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(ASKPASS_DIR, { recursive: true });
}

module.exports = {
  HOME_DIR,
  STATE_DIR,
  STATE_FILE,
  LOG_DIR,
  ASKPASS_DIR,
  SSH_CONFIG_PATH,
  ensureDirs
};
