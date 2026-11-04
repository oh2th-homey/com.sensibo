'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildClimateReactConfig, climateReactTokens, climateReactFingerprint, thresholdToApi, thresholdFromApi, CLIMATE_REACT_NOT_CONFIGURED
} = require('../lib/climate-react');
// Saved in the Sensibo app with the AC in Fahrenheit: above 76.2 °F cool 63 °F, below 69.8 °F heat 79 °F
const savedInApp = require('../samples/smartmode/get-fahrenheit-feelslike.json');
const celsiusWithFahrenheitRules = require('../samples/pods/skyplus-celsius-climate-react-in-fahrenheit.json');
const resavedInApp = require('../samples/pods/skyplus-celsius-climate-react-resaved.json');

// Configuration as GET /smartmode returns it (samples/users-me-pods/all-fields.json)
const current = () => ({
  enabled: true,
  type: 'temperature',
  deviceUid: 'pod',
  lowTemperatureThreshold: 10,
  highTemperatureThreshold: 24,
  lowTemperatureState: {
    on: true, targetTemperature: 22, temperatureUnit: 'C', mode: 'heat', fanLevel: 'medium_high', swing: 'fixedMiddleBottom', horizontalSwing: 'fixedCenterRight'
  },
  highTemperatureState: {
    on: true, targetTemperature: 22, temperatureUnit: 'C', mode: 'cool', fanLevel: 'medium_high', swing: 'fixedMiddleTop', horizontalSwing: 'fixedCenterRight'
  },
  lowTemperatureWebhook: null,
  highTemperatureWebhook: null,
  sync_with_ac_power: false
});

const rule = (overrides) => ({
  type: 'temperature', threshold: 25, on: 'on', mode: 'nop', fanLevel: 'nop', swing: 'nop', horizontalSwing: 'nop', targetTemperature: 18, ...overrides
});

test('changing the high rule keeps the low rule and other settings', () => {
  const config = buildClimateReactConfig(current(), 'high', rule({ mode: 'fan', fanLevel: 'auto' }), 'C');
  const expected = current();
  expected.highTemperatureThreshold = 25;
  expected.highTemperatureState = {
    ...expected.highTemperatureState, mode: 'fan', fanLevel: 'auto', targetTemperature: 18
  };
  assert.deepStrictEqual(config, expected);
});

test('changing the low rule can turn the AC off', () => {
  const config = buildClimateReactConfig(current(), 'low', rule({ threshold: 18, on: 'off' }), 'C');
  assert.strictEqual(config.lowTemperatureThreshold, 18);
  assert.strictEqual(config.lowTemperatureState.on, false);
  assert.strictEqual(config.lowTemperatureState.mode, 'heat');
  assert.deepStrictEqual(config.highTemperatureState, current().highTemperatureState);
});

test('a Fahrenheit AC sends the threshold in Celsius and the target in Fahrenheit', () => {
  const config = buildClimateReactConfig(current(), 'high', rule({ threshold: 76, targetTemperature: 62 }), 'F');
  assert.strictEqual(config.highTemperatureThreshold, 24.44);
  assert.strictEqual(config.highTemperatureState.targetTemperature, 62);
  assert.strictEqual(config.highTemperatureState.temperatureUnit, 'F');
});

test('a humidity threshold is not converted', () => {
  const config = buildClimateReactConfig(current(), 'high', rule({ type: 'humidity', threshold: 70 }), 'F');
  assert.strictEqual(config.type, 'humidity');
  assert.strictEqual(config.highTemperatureThreshold, 70);
});

test('an unconfigured Climate React is refused', () => {
  for (const config of [null, {}, { enabled: false, lowTemperatureThreshold: 24, lowTemperatureState: {} }]) {
    assert.throws(() => buildClimateReactConfig(config, 'low', rule(), 'C'), (err) => err.code === CLIMATE_REACT_NOT_CONFIGURED);
  }
});

test('Fahrenheit thresholds with one decimal survive the round trip', () => {
  for (let tenths = 500; tenths <= 950; tenths++) {
    const f = tenths / 10;
    assert.strictEqual(thresholdFromApi(thresholdToApi(f, 'feelsLike', 'F'), 'feelsLike', 'F'), f);
  }
});

test('tokens show thresholds and states in the AC unit', () => {
  const config = buildClimateReactConfig(current(), 'high', rule({ threshold: 76, targetTemperature: 62, mode: 'cool' }), 'F');
  const tokens = climateReactTokens(config, 'F');
  assert.strictEqual(tokens.high_threshold, 76);
  assert.strictEqual(tokens.low_threshold, 50);
  assert.strictEqual(tokens.unit, '°F');
  assert.strictEqual(tokens.climate_react_enabled, true);
  assert.strictEqual(tokens.high_state, 'On, cool, 62°F, fan medium_high, swing fixedMiddleTop, horizontal fixedCenterRight');
});

test('the fingerprint ignores the enabled flag', () => {
  const config = current();
  const fingerprint = climateReactFingerprint(config);
  config.enabled = false;
  assert.strictEqual(climateReactFingerprint(config), fingerprint);
  config.highTemperatureThreshold = 25;
  assert.notStrictEqual(climateReactFingerprint(config), fingerprint);
});

test('a configuration saved in the Sensibo app shows as the app shows it', () => {
  const { result } = savedInApp;
  const tokens = climateReactTokens(result, 'F');
  assert.strictEqual(tokens.type, 'feelsLike');
  assert.strictEqual(tokens.high_threshold, 76.2);
  assert.strictEqual(tokens.low_threshold, 69.8);
  assert.strictEqual(tokens.high_state, 'On, cool, 63°F, fan auto, swing stopped, horizontal stopped');
  assert.strictEqual(tokens.low_state, 'On, heat, 79°F, fan auto, swing stopped, horizontal stopped');
});

test('a rule changed from Homey keeps the rest of a configuration saved in the Sensibo app', () => {
  const { result } = savedInApp;
  const config = buildClimateReactConfig(result, 'high', rule({
    type: 'nop', threshold: 79, targetTemperature: 61
  }), 'F');
  assert.deepStrictEqual(config, {
    ...result,
    highTemperatureThreshold: 26.11,
    highTemperatureState: { ...result.highTemperatureState, targetTemperature: 61 }
  });
});

test('a rule change on an AC switched back to Celsius stores both rules in Celsius', () => {
  // AC back in Celsius, Climate React rules still in Fahrenheit (samples/pods/skyplus-celsius-climate-react-in-fahrenheit.json)
  const { smartMode } = celsiusWithFahrenheitRules.result;
  const config = buildClimateReactConfig(smartMode, 'high', rule({ type: 'nop', threshold: 26, targetTemperature: 18 }), 'C');
  assert.strictEqual(config.highTemperatureThreshold, 26);
  assert.deepStrictEqual(config.highTemperatureState, { ...smartMode.highTemperatureState, targetTemperature: 18, temperatureUnit: 'C' });
  // The other rule is converted to Celsius, as saving in the Sensibo app does
  assert.deepStrictEqual(config.lowTemperatureState, resavedInApp.result.smartMode.lowTemperatureState);
  const tokens = climateReactTokens(smartMode, 'C');
  assert.strictEqual(tokens.high_threshold, 26.1);
  assert.strictEqual(tokens.low_threshold, 21);
  assert.strictEqual(tokens.unit, '°C');
  assert.strictEqual(tokens.low_state, 'On, heat, 79°F, fan auto, swing stopped, horizontal stopped');
});

test('rules in another unit are converted like the Sensibo app does', () => {
  const { smartMode } = celsiusWithFahrenheitRules.result;
  const config = buildClimateReactConfig(smartMode, 'low', rule({
    type: 'nop', threshold: 21, targetTemperature: 26, mode: 'heat'
  }), 'C');
  assert.deepStrictEqual(config, { ...smartMode, ...resavedInApp.result.smartMode, lowTemperatureThreshold: 21 });
});
