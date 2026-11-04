'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { batteryPercent } = require('../lib/util');

test('Room Sensor battery level follows its voltage from full to empty', () => {
  const levels = [[3000, 100], [2750, 75], [2500, 50], [2250, 25], [2000, 0]];
  for (const [voltage, percent] of levels) {
    assert.strictEqual(batteryPercent(voltage), percent, `${voltage} mV`);
  }
});

test('Room Sensor battery level stays within 0-100 %', () => {
  assert.strictEqual(batteryPercent(3200), 100);
  assert.strictEqual(batteryPercent(1500), 0);
});

test('Room Sensor battery level drops as the voltage drops', () => {
  let previous = batteryPercent(3000);
  for (let voltage = 2990; voltage >= 2000; voltage -= 10) {
    const percent = batteryPercent(voltage);
    assert.ok(percent <= previous, `${voltage} mV: ${percent} % after ${previous} %`);
    previous = percent;
  }
});
