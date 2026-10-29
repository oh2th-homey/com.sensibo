'use strict';

const util = require('./util');

module.exports = class Sensibo {
  constructor(options) {
    if (options == null) {
      options = {};
    }
    this._apikey = options.apikey;
    this._deviceId = options.deviceId;
    this._logger = options.logger;
    this._acState = {};
  }

  getUri(version = 2) {
    return `https://home.sensibo.com/api/v${version}`;
  }

  getDeviceId() {
    return this._deviceId;
  }

  getAcState() {
    return this._acState;
  }

  getErrorMessageFromResponse(response) {
    const data = response && response.data;
    if (data && typeof data === 'object') {
      if (typeof data.message === 'string' && data.message.length > 0) {
        return data.message;
      }
      if (typeof data.reason === 'string' && data.reason.length > 0) {
        return data.reason;
      }
      if (typeof data.error === 'string' && data.error.length > 0) {
        return data.error;
      }
    }
    const result = response && response.data && response.data.result;
    if (result && typeof result === 'object') {
      if (typeof result.message === 'string' && result.message.length > 0) {
        return result.message;
      }
      if (typeof result.error === 'string' && result.error.length > 0) {
        return result.error;
      }
    }
    if (response && typeof response.rawBody === 'string' && response.rawBody.length > 0) {
      return response.rawBody.slice(0, 200);
    }
    return `${response.status} - ${response.statusText}`;
  }

  createApiError(action, response) {
    const apiMessage = this.getErrorMessageFromResponse(response);
    const error = new Error(`Error ${action} (${apiMessage})`);
    error.apiMessage = apiMessage;
    error.apiReason = response && response.data && response.data.reason;
    error.status = response && response.status;
    error.statusText = response && response.statusText;
    error.responseData = response && response.data;
    return error;
  }

  isPodNotConnectedResponse(response) {
    const data = response && response.data;
    const result = data && data.result;
    if (data && typeof data.reason === 'string' && data.reason.includes('PodNotConnected')) {
      return true;
    }
    if (data && typeof data.message === 'string' && data.message.includes('PodNotConnected')) {
      return true;
    }
    if (result && typeof result.reason === 'string' && result.reason.includes('PodNotConnected')) {
      return true;
    }
    if (response && typeof response.rawBody === 'string' && response.rawBody.includes('PodNotConnected')) {
      return true;
    }
    return false;
  }

  async _fetch(method, url, body) {
    const options = {
      method,
      headers: { 'Accept-Encoding': 'gzip' }
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    const rawBody = await response.text();
    let data = {};
    if (rawBody && rawBody.length > 0) {
      try {
        data = JSON.parse(rawBody);
      } catch (err) {
        this._logger('_fetch non-JSON response body', method, util.redactApiKey(url), response.status, response.statusText, rawBody.slice(0, 200));
      }
    }
    return {
      data,
      rawBody,
      status: response.status,
      statusText: response.statusText
    };
  }

  async request(action, method, url, body) {
    const response = await this._fetch(method, url, body);
    if (response.status !== 200) {
      throw this.createApiError(action, response);
    }
    return response.data;
  }

  getApiKey() {
    return this._apikey;
  }

  setApiKey(apikey) {
    this._apikey = apikey;
  }

  async getAllDevices() {
    const fields = 'id,room,productModel,motionSensors';
    return this.request('getting all devices', 'GET', `${this.getUri()}/users/me/pods?fields=${fields}&apiKey=${this.getApiKey()}`);
  }

  async getAllDeviceInfo(apiKey) {
    const fields = 'id,room,productModel,acState,measurements,motionSensors,timer,connectionStatus,filtersCleaning';
    return this.request('getting all device info', 'GET', `${this.getUri()}/users/me/pods?fields=${fields}&apiKey=${apiKey}`);
  }

  getRemoteCapabilities() {
    return this.request('getting remote capabilities', 'GET', `${this.getUri()}/pods/${this.getDeviceId()}?fields=measurements,remoteCapabilities,filtersCleaning&apiKey=${this.getApiKey()}`);
  }

  async getSpecificDeviceInfo() {
    return this.request('getting specific device info', 'GET', `${this.getUri()}/pods/${this.getDeviceId()}?fields=measurements,acState,timer,filtersCleaning&apiKey=${this.getApiKey()}`);
  }

  getAcStates() {
    return this.request('getting AC states', 'GET', `${this.getUri()}/pods/${this.getDeviceId()}/acStates?limit=10&apiKey=${this.getApiKey()}`);
  }

  getModes() {
    return util.getModes(this._remoteCapabilities);
  }

  checkMode(mode) {
    const modes = this.getModes();
    if (modes && !modes.includes(mode)) {
      this._logger(`checkMode: invalid mode: ${mode}`);
      return false;
    }
    return true;
  }

  getAllFanLevels() {
    return util.getAllFanLevels(this._remoteCapabilities);
  }

  getAllSwings() {
    return util.getAllSwings(this._remoteCapabilities);
  }

  getAllHorizontalSwings() {
    return util.getAllHorizontalSwings(this._remoteCapabilities);
  }

  getAllLights() {
    return util.getAllLights(this._remoteCapabilities);
  }

  checkFanLevel(fanLevel) {
    const fanLevels = util.getFanLevels(this._remoteCapabilities, this._acState.mode);
    if (fanLevels && !fanLevels.includes(fanLevel)) {
      this._logger(`checkFanLevel: invalid fan level: ${fanLevel}`);
      return false;
    }
    return true;
  }

  checkSwingMode(swingMode) {
    const swings = util.getSwings(this._remoteCapabilities, this._acState.mode);
    if (swings && !swings.includes(swingMode)) {
      this._logger(`checkSwingMode: invalid swing mode: ${swingMode}`);
      return false;
    }
    return true;
  }

  checkHorizontalSwingMode(swingMode) {
    const swings = util.getHorizontalSwings(this._remoteCapabilities, this._acState.mode);
    if (swings && !swings.includes(swingMode)) {
      this._logger(`checkHorizontalSwingMode: invalid horizontal swing mode: ${swingMode}`);
      return false;
    }
    return true;
  }

  updateAcState(acState) {
    if (acState.on !== undefined) {
      this._acState.on = acState.on;
    }
    if (acState.mode !== undefined) {
      this._acState.mode = acState.mode;
    }
    if (acState.fanLevel !== undefined) {
      this._acState.fanLevel = acState.fanLevel;
    }
    if (acState.targetTemperature !== undefined) {
      let temp = acState.targetTemperature;
      if (this._acState.temperatureUnit === 'F') {
        temp = util.toFahrenheit(temp);
      }
      this._acState.targetTemperature = temp;
    }
    if (acState.temperatureUnit !== undefined) {
      this._acState.temperatureUnit = acState.temperatureUnit;
    }
    if (acState.swing !== undefined) {
      this._acState.swing = acState.swing;
    }
    if (acState.horizontalSwing !== undefined) {
      this._acState.horizontalSwing = acState.horizontalSwing;
    }
    if (acState.light !== undefined) {
      this._acState.light = acState.light;
    }
  }

  buildAcStatePatchPayload(acState) {
    const payload = {};
    const allowedProps = ['on', 'mode', 'fanLevel', 'targetTemperature', 'temperatureUnit', 'swing', 'horizontalSwing', 'light'];
    for (const prop of allowedProps) {
      if (acState[prop] !== undefined && this._acState[prop] !== undefined) {
        payload[prop] = this._acState[prop];
      }
    }
    const requiredProps = ['on', 'mode', 'fanLevel', 'targetTemperature'];
    for (const prop of requiredProps) {
      if (payload[prop] === undefined && this._acState[prop] !== undefined) {
        payload[prop] = this._acState[prop];
      }
    }
    if (payload.targetTemperature !== undefined && payload.temperatureUnit === undefined && this._acState.temperatureUnit !== undefined) {
      payload.temperatureUnit = this._acState.temperatureUnit;
    }
    return payload;
  }

  async setAcState(acState) {
    this.updateAcState(acState);
    const acStatePatch = this.buildAcStatePatchPayload(acState);
    this._logger('setAcState', this.getDeviceId(), acStatePatch);
    return this.request('setting AC state', 'POST', `${this.getUri()}/pods/${this.getDeviceId()}/acStates?apiKey=${this.getApiKey()}`, {
      acState: acStatePatch
    });
  }

  async setAcProperty(property, value) {
    this.updateAcState({
      [property]: value
    });
    this._logger('setAcProperty', this.getDeviceId(), property, value);
    return this.request('setting AC property', 'PATCH', `${this.getUri()}/pods/${this.getDeviceId()}/acStates/${property}?apiKey=${this.getApiKey()}`, {
      newValue: value
    });
  }

  async syncDeviceState(value) {
    this.updateAcState({
      on: value
    });
    return this.request('syncing device state', 'PATCH', `${this.getUri()}/pods/${this.getDeviceId()}/acStates/on?apiKey=${this.getApiKey()}`, {
      newValue: value,
      reason: 'StateCorrectionByUser'
    });
  }

  async getClimateReactSettings() {
    this._logger('getClimateReact', this.getDeviceId());
    return this.request('getting Climate React settings', 'GET', `${this.getUri()}/pods/${this.getDeviceId()}/smartmode?apiKey=${this.getApiKey()}`);
  }

  async enableClimateReact(enabled) {
    this._logger('enableClimateReact', this.getDeviceId(), enabled);
    return this.request('changing Climate React state', 'PUT', `${this.getUri()}/pods/${this.getDeviceId()}/smartmode?apiKey=${this.getApiKey()}`, { enabled });
  }

  async enablePureBoost(enabled) {
    this._logger('enablePureBoost', this.getDeviceId(), enabled);
    return this.request('changing Pure Boost state', 'PUT', `${this.getUri()}/pods/${this.getDeviceId()}/pureboost?apiKey=${this.getApiKey()}`, { enabled });
  }

  async resetFilterIndicator() {
    this._logger('resetFilterIndicator', this.getDeviceId());
    return this.request('resetting filter indicator', 'DELETE', `${this.getUri()}/pods/${this.getDeviceId()}/cleanFiltersNotification?apiKey=${this.getApiKey()}`);
  }

  async isTimerEnabled() {
    this._logger('isTimerEnabled', this.getDeviceId());
    const data = await this.request('getting timer data', 'GET', `${this.getUri()}/pods/${this.getDeviceId()}?fields=timer&apiKey=${this.getApiKey()}`);
    const result = data.result;
    this._logger('isTimerEnabled', this.getDeviceId(), result.timer, !!(result.timer && result.timer.isEnabled));
    return !!(result.timer && result.timer.isEnabled);
  }

  async deleteCurrentTimer() {
    const data = await this.request('deleting timer', 'DELETE', `${this.getUri(1)}/pods/${this.getDeviceId()}/timer/?apiKey=${this.getApiKey()}`);
    this._logger('deleteCurrentTimer', this.getDeviceId(), 200, 'OK');
    return data;
  }

  async setCurrentTimer(minutesFromNow, acState) {
    let temp = acState.targetTemperature || this._acState.targetTemperature;
    if (this._acState.temperatureUnit === 'F' && temp !== undefined) {
      temp = util.toFahrenheit(temp);
    }
    const timerAcState = {
      on: acState.on !== undefined ? acState.on : this._acState.on,
      mode: acState.mode || this._acState.mode,
      fanLevel: acState.fanLevel || this._acState.fanLevel,
      targetTemperature: temp,
      temperatureUnit: this._acState.temperatureUnit,
      swing: this._acState.swing
    };
    this._logger('setCurrentTimer', this.getDeviceId(), minutesFromNow, timerAcState);
    const data = await this.request('setting timer', 'PUT', `${this.getUri(1)}/pods/${this.getDeviceId()}/timer/?apiKey=${this.getApiKey()}`, {
      minutesFromNow,
      acState: timerAcState
    });
    this._logger('setCurrentTimer', this.getDeviceId(), 200, 'OK');
    return data;
  }
};
