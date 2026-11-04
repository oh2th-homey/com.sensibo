'use strict';

const { toCelsius, toFahrenheit } = require('./util');

// Climate React ("smartmode") configuration helpers.
// Thresholds for temperature and feels like are stored by Sensibo in Celsius whatever the AC's unit,
// the AC state for each threshold stores its target temperature in the AC's unit.

const NOP = 'nop';
const CLIMATE_REACT_NOT_CONFIGURED = 'climate_react_not_configured';

const SIDES = Object.freeze({
  high: { threshold: 'highTemperatureThreshold', state: 'highTemperatureState' },
  low: { threshold: 'lowTemperatureThreshold', state: 'lowTemperatureState' }
});

const isTemperatureType = (type) => type !== 'humidity';

const round = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

// Two decimals in Celsius keep a one-decimal Fahrenheit value exact after the round trip (76.2 °F -> 24.56 °C -> 76.2 °F)
const thresholdToApi = (value, type, unit) => {
  if (isTemperatureType(type) && unit === 'F') {
    return round(((value - 32) * 5) / 9, 2);
  }
  return value;
};

const thresholdFromApi = (value, type, unit) => {
  if (typeof value !== 'number') {
    return value;
  }
  // One decimal, as the Sensibo app's threshold slider
  if (isTemperatureType(type) && unit === 'F') {
    return round((value * 9) / 5 + 32, 1);
  }
  return round(value, 1);
};

const unitLabel = (type, unit) => {
  if (!isTemperatureType(type)) {
    return '%';
  }
  return unit === 'F' ? '°F' : '°C';
};

// A rule's target temperature in the given unit, with the conversion table the Sensibo app uses (79 °F = 26 °C)
const toUnit = (state, unit) => {
  if (typeof state.targetTemperature !== 'number' || !state.temperatureUnit || state.temperatureUnit === unit) {
    return state;
  }
  const targetTemperature = unit === 'F' ? toFahrenheit(state.targetTemperature) : toCelsius(state.targetTemperature);
  return { ...state, targetTemperature, temperatureUnit: unit };
};

/**
 * Build the POST /smartmode body that changes one threshold rule and keeps everything else as it is.
 * @param {object} current Current configuration from GET /smartmode (result)
 * @param {'high'|'low'} side Rule to change
 * @param {object} rule { type, threshold, on, mode, fanLevel, swing, horizontalSwing, targetTemperature }, 'nop' leaves a value unchanged
 * @param {string} unit The AC's temperature unit, 'C' or 'F'
 */
const buildClimateReactConfig = (current, side, rule, unit) => {
  const keys = SIDES[side];
  if (!keys) {
    throw new Error(`Unknown Climate React side: ${side}`);
  }
  const other = SIDES[side === 'high' ? 'low' : 'high'];
  if (!current || typeof current[other.threshold] !== 'number' || !current[other.state]) {
    const err = new Error('Climate React has not been configured for this device');
    err.code = CLIMATE_REACT_NOT_CONFIGURED;
    throw err;
  }

  const type = rule.type && rule.type !== NOP ? rule.type : current.type || 'temperature';
  const state = { ...current[keys.state] };
  if (rule.on !== undefined && rule.on !== NOP) {
    state.on = rule.on === 'on' || rule.on === true;
  }
  for (const prop of ['mode', 'fanLevel', 'swing', 'horizontalSwing']) {
    if (rule[prop] !== undefined && rule[prop] !== null && rule[prop] !== NOP) {
      state[prop] = rule[prop];
    }
  }
  if (typeof rule.targetTemperature === 'number') {
    state.targetTemperature = rule.targetTemperature;
    state.temperatureUnit = unit;
  }

  // A changed type also applies to the other threshold, its value is kept as is.
  // Both rules are stored in the AC's current unit, as the Sensibo app does when it saves.
  return {
    ...current,
    type,
    [keys.threshold]: thresholdToApi(rule.threshold, type, unit),
    [keys.state]: toUnit(state, unit),
    [other.state]: toUnit(current[other.state], unit)
  };
};

// Summary of a rule's AC state for a Flow token, e.g. "On, Cool, 62°F, fan Auto, swing Stopped".
// title(prefix, id) returns the translated name of a value from locales/<prefix>.<id>.
const describeState = (state, title) => {
  if (!state) {
    return '';
  }
  if (state.on === false) {
    return title('climate_react', 'off');
  }
  const parts = [title('climate_react', 'on')];
  if (state.mode) parts.push(title('thermostat_mode', state.mode));
  if (typeof state.targetTemperature === 'number') parts.push(`${state.targetTemperature}°${state.temperatureUnit || 'C'}`);
  if (state.fanLevel) parts.push(`${title('climate_react', 'fan')} ${title('fan_level', state.fanLevel)}`);
  if (state.swing) parts.push(`${title('climate_react', 'swing')} ${title('swing', state.swing)}`);
  if (state.horizontalSwing) parts.push(`${title('climate_react', 'horizontal_swing')} ${title('horizontal_swing', state.horizontalSwing)}`);
  return parts.join(', ');
};

/**
 * Flow tokens describing a configuration, thresholds in the AC's unit.
 * title(prefix, id) translates value names for the rule summaries.
 */
const climateReactTokens = (config, unit, title) => {
  const type = config.type || 'temperature';
  return {
    climate_react_enabled: config.enabled === true,
    type,
    unit: unitLabel(type, unit),
    low_threshold: thresholdFromApi(config.lowTemperatureThreshold, type, unit) ?? 0,
    high_threshold: thresholdFromApi(config.highTemperatureThreshold, type, unit) ?? 0,
    low_state: describeState(config.lowTemperatureState, title),
    high_state: describeState(config.highTemperatureState, title)
  };
};

// Fingerprint of the settings, the enabled flag has its own trigger
const climateReactFingerprint = (config) => JSON.stringify([
  config.type,
  config.lowTemperatureThreshold,
  config.highTemperatureThreshold,
  config.lowTemperatureState || null,
  config.highTemperatureState || null
]);

module.exports = {
  NOP,
  CLIMATE_REACT_NOT_CONFIGURED,
  thresholdToApi,
  thresholdFromApi,
  buildClimateReactConfig,
  climateReactTokens,
  climateReactFingerprint,
  describeState
};
