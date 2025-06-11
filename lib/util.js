'use strict';

const sleep = (seconds) => {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};

const randomDelay = (minSeconds, maxSeconds) => {
  const randomDelay = Math.random() * (maxSeconds - minSeconds) + minSeconds;
  return new Promise((resolve) => setTimeout(resolve, randomDelay * 1000));
};

const getModes = (remoteCapabilities) => {
  return remoteCapabilities && remoteCapabilities.modes ? Object.keys(remoteCapabilities.modes) : undefined;
};

const getFanLevels = (remoteCapabilities, mode) => {
  return mode && remoteCapabilities && remoteCapabilities.modes[mode] ? remoteCapabilities.modes[mode].fanLevels : undefined;
};

const getAllFanLevels = (remoteCapabilities) => {
  const modes = getModes(remoteCapabilities);
  if (!modes) {
    return;
  }
  const retMap = new Map();
  for (const mode of modes) {
    const fanLevels = getFanLevels(remoteCapabilities, mode);
    if (fanLevels) {
      for (const fanLevel of fanLevels) {
        retMap.set(fanLevel, fanLevel);
      }
    }
  }
  return retMap.size ? Array.from(retMap.keys()) : undefined;
};

const getSwings = (remoteCapabilities, mode) => {
  return mode && remoteCapabilities && remoteCapabilities.modes[mode] ? remoteCapabilities.modes[mode].swing : undefined;
};

const getAllSwings = (remoteCapabilities) => {
  const modes = getModes(remoteCapabilities);
  if (!modes) {
    return;
  }
  const retMap = new Map();
  for (const mode of modes) {
    const swings = getSwings(remoteCapabilities, mode);
    if (swings) {
      for (const swing of swings) {
        retMap.set(swing, swing);
      }
    }
  }
  return retMap.size ? Array.from(retMap.keys()) : undefined;
};

const getHorizontalSwings = (remoteCapabilities, mode) => {
  return mode && remoteCapabilities && remoteCapabilities.modes[mode] ? remoteCapabilities.modes[mode].horizontalSwing : undefined;
};

const getAllHorizontalSwings = (remoteCapabilities) => {
  const modes = getModes(remoteCapabilities);
  if (!modes) {
    return;
  }
  const retMap = new Map();
  for (const mode of modes) {
    const swings = getHorizontalSwings(remoteCapabilities, mode);
    if (swings) {
      for (const swing of swings) {
        retMap.set(swing, swing);
      }
    }
  }
  return retMap.size ? Array.from(retMap.keys()) : undefined;
};

const getLights = (remoteCapabilities, mode) => {
  return mode && remoteCapabilities && remoteCapabilities.modes[mode] ? remoteCapabilities.modes[mode].light : undefined;
};

const getAllLights = (remoteCapabilities) => {
  const modes = getModes(remoteCapabilities);
  if (!modes) {
    return;
  }
  const retMap = new Map();
  for (const mode of modes) {
    const lights = getLights(remoteCapabilities, mode);
    if (lights) {
      for (const light of lights) {
        retMap.set(light, light);
      }
    }
  }
  return retMap.size ? Array.from(retMap.keys()) : undefined;
};

const AIR_QUALITIES = {
  1: 'Excellent',
  2: 'Fair',
  3: 'Poor'
};

const LEVEL_AQI = {
  1: 'good',
  2: 'fair',
  3: 'poor'
};

const toFahrenheit = (temperature) => {
  // Mapping for common Celsius to Fahrenheit values to avoid drift (C range: 10-30)
  const cToF = {
    10: 50,
    11: 52,
    12: 54,
    13: 55,
    14: 57,
    15: 59,
    16: 61,
    17: 63,
    18: 64,
    19: 66,
    20: 68,
    21: 70,
    22: 72,
    23: 73,
    24: 75,
    25: 77,
    26: 79,
    27: 81,
    28: 82,
    29: 84,
    30: 86,
    31: 88
  };
  const rounded = Math.round(temperature);
  if (cToF.hasOwnProperty(rounded)) {
    return cToF[rounded];
  }
  return Math.round((temperature * 9) / 5 + 32);
};

const toCelsius = (temperature) => {
  // Mapping for common Fahrenheit to Celsius values to avoid drift (F range: 50-88)
  const fToC = {
    50: 10,
    52: 11,
    54: 12,
    55: 13,
    57: 14,
    59: 15,
    61: 16,
    63: 17,
    64: 18,
    66: 19,
    68: 20,
    70: 21,
    72: 22,
    73: 23,
    75: 24,
    77: 25,
    79: 26,
    81: 27,
    82: 28,
    84: 29,
    86: 30,
    88: 31
  };
  const rounded = Math.round(temperature);
  if (fToC.hasOwnProperty(rounded)) {
    return fToC[rounded];
  }
  return Math.round(((temperature - 32) * 5) / 9);
};

module.exports = {
  sleep,
  randomDelay,
  getModes,
  getFanLevels,
  getAllFanLevels,
  getSwings,
  getAllSwings,
  getHorizontalSwings,
  getAllHorizontalSwings,
  getLights,
  getAllLights,
  AIR_QUALITIES,
  LEVEL_AQI,
  toFahrenheit,
  toCelsius
};
