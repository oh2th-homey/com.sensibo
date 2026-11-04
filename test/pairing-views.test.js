'use strict';

// The API key view is shared by all drivers through Homey Compose templates (#69).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('the pairing and repair API key views have the same source', () => {
  assert.strictEqual(
    read('.homeycompose', 'drivers', 'repair', 'enter_api_key', 'index.html'),
    read('.homeycompose', 'drivers', 'pair', 'enter_api_key', 'index.html')
  );
});

test('every driver uses the shared API key view for pairing and repair', () => {
  const template = JSON.parse(read('.homeycompose', 'drivers', 'templates', 'defaults.json'));
  for (const step of ['pair', 'repair']) {
    const view = template[step].find((candidate) => candidate.id === 'enter_api_key');
    assert.strictEqual(view.$template, 'enter_api_key', step);
  }
  for (const driver of fs.readdirSync(path.join(root, 'drivers'))) {
    const compose = path.join(root, 'drivers', driver, 'driver.compose.json');
    if (fs.existsSync(compose)) {
      assert.ok(JSON.parse(fs.readFileSync(compose, 'utf8')).$extends.includes('defaults'), driver);
    }
  }
});
