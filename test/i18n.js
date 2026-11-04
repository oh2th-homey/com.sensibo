'use strict';

// this.homey.__() for tests: English strings from locales/en.json with __name__ placeholders filled in.
// Like Homey, it returns the key when there is no string for it.
const en = require('../locales/en.json');

const translate = (key, tokens = {}) => {
  const value = key.split('.').reduce((obj, part) => (obj && typeof obj === 'object' ? obj[part] : undefined), en);
  return typeof value === 'string' ? value.replace(/__(\w+)__/g, (match, name) => String(tokens[name])) : key;
};

module.exports = { translate };
