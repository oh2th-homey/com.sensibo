'use strict';

const Homey = require('homey');
const Sensibo = require('../lib/sensibo');
const util = require('../lib/util');
const { NOP, CLIMATE_REACT_NOT_CONFIGURED, buildClimateReactConfig } = require('../lib/climate-react');

// All locale files, to give runtime picker values translated titles in every language
const LANGUAGES = ['en', 'nl', 'de', 'fr', 'it', 'sv', 'no', 'es', 'da', 'ru', 'pl', 'ko', 'ar'];
// eslint-disable-next-line import/no-dynamic-require, global-require
const LOCALES = Object.fromEntries(LANGUAGES.map((language) => [language, require(`../locales/${language}.json`)]));

module.exports = class BaseDevice extends Homey.Device {
  async onInit() {
    await this.migrate();
    await this.createSensiboApi(this.log);
    // Changes within this window are sent as one command, so the AC beeps only once.
    // Each new change restarts the window. Cards in a normal Flow run arrive milliseconds apart and are merged.
    // Kept at 500 ms for responsive controls: a longer window delays every command, including a single tap.
    // Running cards one by one in the Flow editor spaces them ~1.5 s apart, so those are sent separately.
    this._acStateBatchWindowMs = 500;
    this._pendingAcStatePatch = {};
    this._acStateBatchResolvers = [];
    this._acStateBatchRejectors = [];
    await this.registerCapabilityListeners();
    await this.fetchRemoteCapabilities();
    this.log(`${this.deviceName()} device initialized`);
    this._initialized = true;
    this.homey.app.scheduleCheckData(15);
  }

  async onUninit() {
    this._deleted = true;
    this.clearAcStateBatch();
    this.clearCheckData();
  }

  clearAcStateBatch() {
    if (this._acStateBatchTimeout) {
      this.homey.clearTimeout(this._acStateBatchTimeout);
      this._acStateBatchTimeout = undefined;
    }
    this._pendingAcStatePatch = {};
    const rejectors = this._acStateBatchRejectors;
    this._acStateBatchResolvers = [];
    this._acStateBatchRejectors = [];
    for (const reject of rejectors) {
      reject(new Error(this.homey.__('errors.change_not_sent')));
    }
  }

  resolvePendingAcStateBatch(value, resolvers = this._acStateBatchResolvers) {
    this._acStateBatchResolvers = [];
    this._acStateBatchRejectors = [];
    for (const resolve of resolvers) {
      resolve(value);
    }
  }

  scheduleAcStateBatchFlush() {
    if (this._acStateBatchTimeout) {
      this.homey.clearTimeout(this._acStateBatchTimeout);
      this._acStateBatchTimeout = undefined;
    }
    this._acStateBatchTimeout = this.homey.setTimeout(() => {
      this.flushAcStateBatch().catch((err) => {
        this.log('scheduleAcStateBatchFlush error', err);
      });
    }, this._acStateBatchWindowMs);
  }

  queueAcStatePatch(patch) {
    if (this._deleted) {
      throw new Error(this.homey.__('errors.device_deleted'));
    }
    // Keep local state in sync with queued updates so subsequent validations use the effective pending state.
    this._sensibo.updateAcState(patch);
    this._pendingAcStatePatch = { ...this._pendingAcStatePatch, ...patch };
    const batchPromise = new Promise((resolve, reject) => {
      this._acStateBatchResolvers.push(resolve);
      this._acStateBatchRejectors.push(reject);
    });
    // Attach a no-op rejection handler so fire-and-forget callers do not create unhandled rejections.
    batchPromise.catch(() => {});
    this.scheduleAcStateBatchFlush();
    return batchPromise;
  }

  async flushAcStateBatch() {
    if (this._deleted) {
      this.clearAcStateBatch();
      return;
    }
    if (this._acStateBatchTimeout) {
      this.homey.clearTimeout(this._acStateBatchTimeout);
      this._acStateBatchTimeout = undefined;
    }
    const patch = this._pendingAcStatePatch;
    const resolvers = this._acStateBatchResolvers;
    this._pendingAcStatePatch = {};
    this._acStateBatchResolvers = [];
    this._acStateBatchRejectors = [];
    if (Object.keys(patch).length === 0) {
      this.resolvePendingAcStateBatch(undefined, resolvers);
      return;
    }
    try {
      const properties = Object.keys(patch);
      if (properties.length === 1) {
        // A single change is sent as a PATCH, so no cached values are resent with it
        await this._sensibo.setAcProperty(properties[0], patch[properties[0]]);
      } else {
        // The full state POST sends all changes as one command, so the AC beeps only once
        await this._sensibo.setAcState(patch);
      }
      await this.ensureDeviceAvailable();
      this.resolvePendingAcStateBatch(undefined, resolvers);
    } catch (err) {
      this.log('flushAcStateBatch error', err);
      await this.setUnavailableFromApiError(err);
      this.resolvePendingAcStateBatch(undefined, resolvers);
    }
  }

  getApiFailureMessage(err) {
    if (err && typeof err.apiMessage === 'string' && err.apiMessage.length > 0) {
      return err.apiMessage;
    }
    if (err && typeof err.message === 'string' && err.message.length > 0) {
      return err.message;
    }
    return this.homey.__('errors.unknown_api_error');
  }

  async setUnavailableFromApiError(err) {
    const message = this.getApiFailureMessage(err);
    // A single timeout is usually transient, only go unavailable if the next request times out too
    if (err && err.timeout) {
      this._consecutiveTimeouts = (this._consecutiveTimeouts || 0) + 1;
      if (this._consecutiveTimeouts < 2) {
        this.log('setUnavailableFromApiError ignoring first timeout', message);
        return;
      }
    }
    try {
      await this.setUnavailable(message);
    } catch (setUnavailableErr) {
      this.log('setUnavailableFromApiError error', setUnavailableErr);
    }
  }

  async handleApiFailure(context, err) {
    await this.setUnavailableFromApiError(err);
    const message = this.getApiFailureMessage(err);
    this.log(`${context} error`, message);
    throw message;
  }

  async ensureDeviceAvailable() {
    this._consecutiveTimeouts = 0;
    try {
      if (!this.getAvailable()) {
        await this.setAvailable();
      }
    } catch (err) {
      this.log('ensureDeviceAvailable error', err);
    }
  }

  async migrate() {}

  getApiKey() {
    return this.getStoreValue('apikey');
  }

  async updateApiKey(apikey) {
    await this.setStoreValue('apikey', apikey);
    if (this._sensibo) {
      this._sensibo.setApiKey(apikey);
      await this.fetchRemoteCapabilities();
    }
  }

  isInitialized() {
    return this._initialized;
  }

  async createSensiboApi(logger) {
    this._sensibo = new Sensibo({
      homey: this.homey,
      apikey: this.getApiKey(),
      deviceId: this.getData().id,
      logger
    });
  }

  async registerCapabilityListeners() {}

  async fetchRemoteCapabilities() {
    try {
      const data = await this._sensibo.getRemoteCapabilities();
      if (data && data.result) {
        const remoteMeasurements = data.result.measurements ? { measurements: data.result.measurements } : {};
        const filtersCleaning = data.result.filtersCleaning ? { filtersCleaning: data.result.filtersCleaning } : {};

        const result = { ...data.result.remoteCapabilities, ...remoteMeasurements, ...filtersCleaning };
        this.log('fetchRemoteCapabilities', result);
        this._sensibo._remoteCapabilities = result;
        await this.onRemoteCapabilitiesReceived(result);
        await this.ensureDeviceAvailable();
      }
    } catch (err) {
      await this.setUnavailableFromApiError(err);
      this.log('fetchRemoteCapabilities error', this.getApiFailureMessage(err));
    }
  }

  // Translated title of an AC value (mode, fan level, swing, ...) from locales/<i18nPrefix>.<id>.
  // Unknown values fall back to a readable id, e.g. medium_high -> Medium high, fixedMiddleTop -> Fixed middle top.
  valueTitle(i18nPrefix, id) {
    const key = `${i18nPrefix}.${id}`;
    const title = this.homey.__(key);
    if (title && title !== key) {
      return title;
    }
    const readable = id.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    return readable.charAt(0).toUpperCase() + readable.slice(1);
  }

  // Title of an AC value as a translation object for capability options, e.g. { en: 'Quiet', sv: 'Tyst', ... }.
  // Homey shows it in the current language and follows a language change; English falls back to a readable id.
  valueTitles(i18nPrefix, id) {
    const titles = {};
    for (const language of LANGUAGES) {
      const section = LOCALES[language][i18nPrefix];
      if (section && typeof section[id] === 'string') {
        titles[language] = section[id];
      }
    }
    if (!titles.en) {
      const readable = id.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      titles.en = readable.charAt(0).toUpperCase() + readable.slice(1);
    }
    return titles;
  }

  // Flow autocomplete list of AC values with translated names, filtered by the typed query
  valueAutocomplete(query, ids, i18nPrefix) {
    return ids
      .map((id) => ({ id, name: this.valueTitle(i18nPrefix, id) }))
      .filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
  }

  // Set the picker values of an enum capability to what the remote device supports.
  // Known ids are listed in the given order, new ones are appended.
  // Titles come from locales/<i18nPrefix>.<id>, unknown values fall back to a readable id.
  async updateEnumCapabilityValues(capabilityId, remoteIds, i18nPrefix, order = []) {
    const ids = [...order.filter((id) => remoteIds.includes(id)), ...remoteIds.filter((id) => !order.includes(id))];
    // Fetch current options (may throw if not set yet, so wrap safely)
    let currentOptions;
    try {
      currentOptions = this.getCapabilityOptions(capabilityId);
    } catch (err) {
      currentOptions = {};
    }
    const values = ids.map((id) => ({ id, title: this.valueTitles(i18nPrefix, id) }));
    // Update only if the values or their titles changed; titles stored as plain strings by older versions are replaced
    if (JSON.stringify(currentOptions.values || []) === JSON.stringify(values)) {
      return;
    }
    await this.setCapabilityOptions(capabilityId, { values });
    this.log(`Updated ${capabilityId} options ->`, ids);
  }

  async onRemoteCapabilitiesReceived(capabilities) {
    // Adjust modes for thermostat_mode
    if (capabilities.modes !== undefined && this.hasCapability('thermostat_mode') === true) {
      const defaultModes = ['auto', 'heat', 'cool', 'off'];
      // Modes reported by the remote device
      const remoteModes = util.getModes(capabilities) || [];
      const availableModes = [...defaultModes, ...remoteModes.filter((mode) => !defaultModes.includes(mode))];
      await this.updateEnumCapabilityValues('thermostat_mode', availableModes, 'thermostat_mode');
    }

    // Adjust fan levels and swings to the values reported by the remote device
    if (capabilities.modes !== undefined) {
      const remoteFanLevels = util.getAllFanLevels(capabilities);
      if (remoteFanLevels && this.hasCapability('se_fanlevel') === true) {
        await this.updateEnumCapabilityValues('se_fanlevel', remoteFanLevels, 'fan_level', [
          'quiet', 'low', 'medium_low', 'medium', 'medium_high', 'high', 'strong', 'auto'
        ]);
      }
      const remoteSwings = util.getAllSwings(capabilities);
      if (remoteSwings && this.hasCapability('se_fandirection') === true) {
        await this.updateEnumCapabilityValues('se_fandirection', remoteSwings, 'swing', [
          'stopped', 'fixedBottom', 'fixedMiddleBottom', 'fixedMiddle', 'fixedMiddleTop', 'fixedTop',
          'rangeBottom', 'rangeMiddle', 'rangeTop', 'rangeFull', 'horizontal', 'both'
        ]);
      }
      const remoteHorizontalSwings = util.getAllHorizontalSwings(capabilities);
      if (remoteHorizontalSwings && this.hasCapability('se_horizontal_swing') === true) {
        await this.updateEnumCapabilityValues('se_horizontal_swing', remoteHorizontalSwings, 'horizontal_swing', [
          'stopped', 'fixedLeft', 'fixedCenterLeft', 'fixedCenter', 'fixedCenterRight', 'fixedRight',
          'fixedLeftRight', 'rangeCenter', 'rangeFull'
        ]);
      }
    }

    // Add Sensibo device model specific measurement capabilities, if available and not yet added.
    if (capabilities.measurements.tvoc !== undefined && this.hasCapability('measure_tvoc') === false) {
      await this.addCapability('measure_tvoc');
    }
    if (capabilities.measurements.co2 !== undefined && this.hasCapability('measure_co2') === false) {
      await this.addCapability('measure_co2');
    }
    if (capabilities.measurements.iaq !== undefined && this.hasCapability('measure_iaq') === false) {
      await this.addCapability('measure_iaq');
    }
    if (capabilities.measurements.pm25 !== undefined && this.hasCapability('level_aqi') === false) {
      await this.addCapability('level_aqi');
    }
    // To be deprecated in favor of level_aqi
    if (this.hasCapability('air_quality') === true) {
      await this.removeCapability('air_quality');
    }
  }

  deviceName = () => {
    throw new Error('Not implemented');
  };

  onAdded() {
    this.homey.app.scheduleCheckData(5);
    this.log(`${this.deviceName()} added:`, this.getData().id);
  }

  onDeleted() {
    this._deleted = true;
    this.clearAcStateBatch();
    this.clearCheckData();
    this.clearTimer();
    this.log(`${this.deviceName()} deleted`);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('Polling_Interval')) {
      this.scheduleCheckData();
    }
  }

  async onDeviceInfoReceived(result) {
    if (result) {
      this.log(`Device info for: ${this.getData().id}:`, result);
      await this.ensureDeviceAvailable();
      // Only convert targetTemperature if unit is F, measurements.temperature is always in C
      if (result.acState && result.acState.temperatureUnit === 'F') {
        if (typeof result.acState.targetTemperature === 'number') {
          const origTemp = result.acState.targetTemperature;
          result.acState.targetTemperature = util.toCelsius(origTemp);
          this.log(`Converted targetTemperature from F (${origTemp}) to C (${result.acState.targetTemperature})`);
        }
      }
      if (result.acState) {
        this._sensibo.updateAcState(result.acState);
        if (await this.updateIfChanged('se_onoff', result.acState.on)) {
          if (result.acState.on) {
            this.homey.app._turnedOnTrigger
              .trigger(this, { state: 1 }, {})
              .then(() => this.log(`Turned on triggered: ${this.getData().id}`))
              .catch((err) => this.log('Error triggering Turned on:', err));
          } else {
            this.homey.app._turnedOffTrigger
              .trigger(this, { state: 0 }, {})
              .then(() => this.log(`Turned off triggered: ${this.getData().id}`))
              .catch((err) => this.log('Error triggering Turned off:', err));
          }
        }

        await this.updateIfChanged('target_temperature', result.acState.targetTemperature);
        await this.updateIfChanged('se_fanlevel', result.acState.fanLevel);
        await this.updateIfChanged('se_fanlevel_pure', result.acState.fanLevel);
        await this.updateIfChanged('se_fandirection', result.acState.swing);
        await this.updateIfChanged('se_horizontal_swing', result.acState.horizontalSwing);
        const thermostat_mode = result.acState.on === false ? 'off' : result.acState.mode;
        if (thermostat_mode) {
          await this.updateIfChanged('thermostat_mode', thermostat_mode);
        }
      }
      if (result.timer && result.timer.isEnabled && result.timer.targetTimeSecondsFromNow >= 0) {
        this.scheduleTimer(result.timer.targetTimeSecondsFromNow);
      } else {
        this.clearTimer();
      }
      const hasTimer = !!result.timer;
      const hasTimerEnabled = !!(result.timer && result.timer.isEnabled);
      if (this._hasTimerEnabled === false && hasTimerEnabled === true) {
        this.homey.app._timerCreatedTrigger
          .trigger(this, { homey: false }, {})
          .then(() => this.log(`Timer created triggered: ${this.getData().id}`))
          .catch((err) => this.log('Error triggering Timer created:', err));
      } else if (this._hasTimer === true && hasTimer === false) {
        this.homey.app._timerDeletedTrigger
          .trigger(this, { homey: false }, {})
          .then(() => this.log(`Timer deleted triggered: ${this.getData().id}`))
          .catch((err) => this.log('Error triggering Timer deleted:', err));
      }
      this._hasTimer = hasTimer;
      this._hasTimerEnabled = hasTimerEnabled;
      const roomSensor = util.roomSensorState(result);
      if (roomSensor) {
        await this.updateRoomSensorCapability(roomSensor);
      }
      if (result.measurements) {
        // With a Room Sensor as the primary sensor, temperature and humidity come from it
        const climate = roomSensor && roomSensor.measurements ? roomSensor.measurements : result.measurements;
        await this.updateIfChanged('measure_temperature', climate.temperature);
        await this.updateIfChanged('measure_humidity', climate.humidity);
        if (result.measurements.batteryVoltage) {
          if (result.productModel === 'motion_sensor') {
            await this.updateIfChanged('measure_battery', util.batteryPercent(result.measurements.batteryVoltage));
          }
        }
        if (result.measurements.co2) {
          await this.updateIfChanged('measure_co2', result.measurements.co2);
        }
        if (result.measurements.tvoc) {
          // Sensibo API returns TVOC in ppb, Homey expects µg/m³.
          // Approximate conversion: 1 ppb ≈ 4.09 µg/m³ (approximation at 25°C, 1 atm)
          await this.updateIfChanged('measure_tvoc', Math.round(result.measurements.tvoc * 4.09));
        }
        if (result.measurements.etoh) {
          await this.updateIfChanged('measure_etoh', result.measurements.etoh);
        }
        if (result.measurements.iaq) {
          await this.updateIfChanged('measure_iaq', result.measurements.iaq);
        }
        // PM2.5 is different for Pure (air_quality reference) and Elements (pm25 value)
        if (result.measurements.pm25) {
          if (result.productModel === 'pure') {
            const level_aqi = util.LEVEL_AQI[result.measurements.pm25];
            if (level_aqi) {
              await this.updateIfChanged('level_aqi', level_aqi);
            }
          }
          if (result.productModel === 'elements') {
            await this.updateIfChanged('measure_pm25', result.measurements.pm25);
          }
        }
        if (result.measurements.time) {
          const lastSeen = new Date(result.measurements.time.time).toLocaleTimeString('POSIX', { hour12: false, timeZone: this.homey.clock.getTimezone() });

          await this.updateIfChanged('se_last_seen_seconds', result.measurements.time.secondsAgo);
          await this.updateIfChanged('se_last_seen', lastSeen);

          const settings = await this.getSettings();
          const limitOffline = settings.Delay_Offline || 300;

          if (result.measurements.time.secondsAgo > limitOffline && !this._offlineTrigged) {
            try {
              await this.homey.app._offlineTrigger.trigger(
                this,
                {
                  seconds_ago: result.measurements.time.secondsAgo,
                  last_seen: lastSeen
                },
                {}
              );
              this._offlineTrigged = true;
            } catch (error) {
              this._offlineTrigged = false;
            }
          }
        }
      }
      // Does the device have filters and their cleaning information.
      if (this.hasCapability('alarm_filter')) {
        // Update and trigger alarm_filter if changed.
        if (await this.updateIfChanged('alarm_filter', result.filtersCleaning.shouldCleanFilters)) {
          this.homey.app._filterAlarmTrigger
            .trigger(this, { state: result.filtersCleaning.shouldCleanFilters }, {})
            .then(() => this.log(`Clean Filter alarm triggered: ${this.getData().id}`))
            .catch((err) => this.log('Error triggering Clean Filter alarm:', err));
        }
        const filterCleanTimeLeft = result.filtersCleaning.filtersCleanSecondsThreshold - result.filtersCleaning.acOnSecondsSinceLastFiltersClean;
        if (filterCleanTimeLeft > 0) {
          const dueDate = new Date(Date.now() + filterCleanTimeLeft * 1000);
          // Format due date to yyyy-MM-dd
          await this.updateIfChanged('se_filter_due_date', dueDate.toISOString().split('T')[0]);
          // Format due date to hours remaining
          await this.updateIfChanged('se_filter_due_hours', Math.ceil(filterCleanTimeLeft / 3600));
        }
        // Run hours since last filter clean
        await this.updateIfChanged('se_filter_run_hours', Math.floor(result.filtersCleaning.acOnSecondsSinceLastFiltersClean / 3600));
      }
      // Climate React comes with the shared poll, null when it has never been configured
      if (Object.hasOwn(result, 'smartMode') && this.onClimateReactSettingsReceived) {
        await this.onClimateReactSettingsReceived({ result: result.smartMode || {} });
      }
    }
  }

  // "Use Room Sensor" shows whether the Room Sensor is the AC's primary sensor in the Sensibo app.
  // It only exists while the AC has a Room Sensor.
  async updateRoomSensorCapability({ hasRoomSensor, inUse }) {
    try {
      if (hasRoomSensor && !this.hasCapability('se_use_roomsensor')) {
        await this.addCapability('se_use_roomsensor');
      } else if (!hasRoomSensor && this.hasCapability('se_use_roomsensor')) {
        await this.removeCapability('se_use_roomsensor');
      }
      if (hasRoomSensor) {
        await this.updateIfChanged('se_use_roomsensor', inUse);
      }
    } catch (err) {
      this.log('updateRoomSensorCapability error', err);
    }
  }

  async updateIfChanged(cap, toValue) {
    if (this.hasCapability(cap) && toValue !== undefined) {
      const capValue = this.getCapabilityValue(cap);
      if (capValue !== toValue || capValue === undefined || capValue === null) {
        await this.setCapabilityValue(cap, toValue).catch((err) => this.log(err));
        return true;
      }
    }
    return false;
  }

  clearCheckData() {
    if (this.curTimeout) {
      this.homey.clearTimeout(this.curTimeout);
      this.curTimeout = undefined;
    }
  }

  scheduleCheckData(seconds) {
    if (this._deleted) {
      return;
    }
    this.clearCheckData();
    let interval = seconds;
    if (!interval) {
      const settings = this.getSettings();
      interval = settings.Polling_Interval || 30;
    }
    this.curTimeout = this.homey.setTimeout(() => {
      this.checkData().catch((err) => this.log('checkData error', err));
    }, interval * 1000);
  }

  async checkData() {}

  clearTimer() {
    if (this.curTimer) {
      this.homey.clearTimeout(this.curTimer);
      this.curTimer = undefined;
    }
  }

  scheduleTimer(seconds) {
    if (this._deleted) {
      return;
    }
    this.clearTimer();
    this.curTimer = this.homey.setTimeout(() => {
      this.onTimerFired().catch((err) => this.log('onTimerFired error', err));
    }, seconds * 1000 + 1);
  }

  async onTimerFired() {
    if (this._deleted) {
      return;
    }
    try {
      this.clearTimer();
      this.homey.app._timerFiredTrigger
        .trigger(this, { state: 1 }, {})
        .then(() => this.log(`Timer fired for: ${this._sensibo.getDeviceId()}`))
        .catch((err) => this.log('Error triggering Timer fired:', err));
    } catch (err) {
      this.log('onTimerFired error', err);
    }
  }

  async onActionTurnOn() {
    try {
      this.clearCheckData();
      this.log(`turn on: ${this._sensibo.getDeviceId()}`);
      this.queueAcStatePatch({ on: true });
      await this.setCapabilityValue('se_onoff', true).catch((err) => this.log(err));
      if (this.hasCapability('thermostat_mode')) {
        let mode = this._sensibo.getAcState()['mode'];
        mode = mode || 'auto';
        await this.setCapabilityValue('thermostat_mode', mode).catch((err) => this.log(err));
      }
      this.homey.app._turnedOnTrigger.trigger(this, { state: 1 }, {}).catch((err) => this.log('Error triggering Turned on:', err));
      this.log(`turned on OK: ${this._sensibo.getDeviceId()}`);
    } catch (err) {
      const message = this.getApiFailureMessage(err);
      this.log('onActionTurnOn error', message);
      throw message;
    } finally {
      this.scheduleCheckData();
    }
  }

  async onActionTurnOff() {
    try {
      this.clearCheckData();
      this.log(`turn off: ${this._sensibo.getDeviceId()}`);
      this.queueAcStatePatch({ on: false });
      await this.setCapabilityValue('se_onoff', false).catch((err) => this.log(err));
      if (this.hasCapability('thermostat_mode')) {
        await this.setCapabilityValue('thermostat_mode', 'off').catch((err) => this.log(err));
      }
      this.homey.app._turnedOffTrigger.trigger(this, { state: 0 }, {}).catch((err) => this.log('Error triggering Turned off:', err));
      this.log(`turned off OK: ${this._sensibo.getDeviceId()}`);
    } catch (err) {
      const message = this.getApiFailureMessage(err);
      this.log('onActionTurnOff error', message);
      throw message;
    } finally {
      this.scheduleCheckData();
    }
  }

  async onActionSetMode(mode) {
    try {
      this.clearCheckData();
      if (this._sensibo.checkMode(mode)) {
        this.log(`set fan mode: ${this._sensibo.getDeviceId()} -> ${mode}`);
        this.queueAcStatePatch({ mode });
        this.log(`set fan mode OK: ${this._sensibo.getDeviceId()} -> ${mode}`);
      }
    } catch (err) {
      const message = this.getApiFailureMessage(err);
      this.log('onActionSetMode error', message);
      throw message;
    } finally {
      this.scheduleCheckData();
    }
  }

  async onModeAutocomplete(query, args) {
    return this.valueAutocomplete(query, this._sensibo.getModes() || ['cool', 'heat', 'fan', 'auto', 'dry'], 'thermostat_mode');
  }

  async onActionSetFanLevel(fanLevel) {
    await this.onUpdateFanlevel(fanLevel);
    if (this.hasCapability('se_fanlevel')) {
      await this.setCapabilityValue('se_fanlevel', fanLevel).catch((err) => this.log(err));
    }
  }

  async onFanLevelAutocomplete(query, args) {
    return this.valueAutocomplete(query, this._sensibo.getAllFanLevels() || ['auto', 'high', 'medium', 'low'], 'fan_level');
  }

  async onActionSetSwing(swing) {
    await this.onUpdateSwing(swing);
    if (this.hasCapability('se_fandirection')) {
      await this.setCapabilityValue('se_fandirection', swing).catch((err) => this.log(err));
    }
  }

  async onSwingAutocomplete(query, args) {
    return this.valueAutocomplete(query, this._sensibo.getAllSwings() || ['stopped', 'fixedBottom', 'fixedTop', 'rangeTop', 'rangeFull'], 'swing');
  }

  async onActionSetHorizontalSwing(horizontalSwing) {
    await this.onUpdateHorizontalSwing(horizontalSwing);
    if (this.hasCapability('se_horizontal_swing')) {
      await this.setCapabilityValue('se_horizontal_swing', horizontalSwing).catch((err) => this.log(err));
    }
  }

  async onHorizontalSwingAutocomplete(query, args) {
    return this.valueAutocomplete(query, this._sensibo.getAllHorizontalSwings() || ['stopped', 'fixedLeft', 'fixedRight', 'rangeCenter', 'rangeFull'], 'horizontal_swing');
  }

  async onActionClimateReact(enabled) {
    await this.onUpdateClimateReact(enabled);
    if (this.hasCapability('se_climate_react')) {
      await this.setCapabilityValue('se_climate_react', enabled).catch((err) => this.log(err));
    }
  }

  // The AC's temperature unit, Climate React flow cards take temperatures in it
  getTemperatureUnit() {
    const acState = this._sensibo.getAcState() || {};
    return acState.temperatureUnit === 'F' ? 'F' : 'C';
  }

  async onActionSetClimateReactRule(side, args) {
    const rule = {
      type: args.type,
      threshold: args.threshold,
      on: args.on,
      mode: args.mode && args.mode.id,
      fanLevel: args.fanLevel && args.fanLevel.id,
      swing: args.swing && args.swing.id,
      horizontalSwing: args.horizontalSwing && args.horizontalSwing.id,
      targetTemperature: args.targetTemperature
    };
    try {
      this.clearCheckData();
      const current = await this._sensibo.getClimateReactSettings();
      const config = buildClimateReactConfig(current && current.result, side, rule, this.getTemperatureUnit());
      this.log(`set Climate React ${side} rule: ${this._sensibo.getDeviceId()}`, config);
      await this._sensibo.setClimateReactSettings(config);
      await this.ensureDeviceAvailable();
    } catch (err) {
      if (err && err.code === CLIMATE_REACT_NOT_CONFIGURED) {
        throw new Error(this.homey.__('errors.climate_react_not_configured'));
      }
      await this.handleApiFailure('onActionSetClimateReactRule', err);
    } finally {
      this.scheduleCheckData();
    }
  }

  // Autocomplete for a Climate React rule: the AC's values, first an option that keeps the current value
  async withUnchangedOption(query, itemsPromise) {
    const items = await itemsPromise;
    const unchanged = { id: NOP, name: this.homey.__('flow.unchanged') };
    return unchanged.name.toLowerCase().includes(query.toLowerCase()) || !query ? [unchanged, ...items] : items;
  }

  async isTimerEnabled() {
    try {
      const isEnabled = await this._sensibo.isTimerEnabled();
      await this.ensureDeviceAvailable();
      return isEnabled;
    } catch (err) {
      await this.setUnavailableFromApiError(err);
      throw this.getApiFailureMessage(err);
    }
  }

  async isLightOn() {
    const lightModes = this._sensibo.getAllLights();
    if (lightModes) {
      const light = this._sensibo.getAcState()['light'];
      return !!light && light !== 'off';
    }
    throw new Error(this.homey.__('errors.light_not_supported'));
  }

  async onDeleteTimer() {
    try {
      this.clearCheckData();
      await this._sensibo.deleteCurrentTimer();
      await this.ensureDeviceAvailable();
      this._hasTimer = false;
      this._hasTimerEnabled = false;
      this.homey.app._timerDeletedTrigger.trigger(this, { homey: true }, {}).catch((err) => this.log('Error triggering Timer deleted:', err));
    } catch (err) {
      await this.handleApiFailure('onDeleteTimer', err);
    } finally {
      this.scheduleCheckData();
    }
  }

  async onSetTimer(minutesFromNow, on, mode, fanLevel, targetTemperature) {
    this.log('onSetTimer', minutesFromNow, on, on === 'on', mode, fanLevel, targetTemperature);
    const newAcState = {
      on: on !== 'nop' ? on === 'on' : undefined,
      mode: mode !== 'nop' ? mode : undefined,
      fanLevel: fanLevel !== 'nop' ? fanLevel : undefined,
      targetTemperature: targetTemperature >= 10 ? targetTemperature : undefined
    };
    if (minutesFromNow <= 0) {
      throw new Error(this.homey.__('errors.timer_minutes_required'));
    }
    if (minutesFromNow > 1440) {
      throw new Error(this.homey.__('errors.timer_minutes_too_large', { max: 1440 }));
    }
    if (newAcState.on === undefined && newAcState.mode === undefined && newAcState.fanLevel === undefined && newAcState.targetTemperature === undefined) {
      throw new Error(this.homey.__('errors.timer_nothing_to_set'));
    }
    try {
      this.clearCheckData();
      await this._sensibo.setCurrentTimer(minutesFromNow, newAcState);
      await this.ensureDeviceAvailable();
      this._hasTimer = true;
      this._hasTimerEnabled = true;
      this.homey.app._timerCreatedTrigger.trigger(this, { homey: true }, {}).catch((err) => this.log('Error triggering Timer created:', err));
    } catch (err) {
      await this.handleApiFailure('onSetTimer', err);
    } finally {
      this.scheduleCheckData();
    }
  }

  async onControlLight(state) {
    try {
      this.clearCheckData();
      this.log(`set light: ${this._sensibo.getDeviceId()} -> ${state}`);
      this.queueAcStatePatch({ light: state });
      this.log(`set light OK: ${this._sensibo.getDeviceId()} -> ${state}`);
    } catch (err) {
      const message = this.getApiFailureMessage(err);
      this.log('onControlLight error', message);
      throw message;
    } finally {
      this.scheduleCheckData();
    }
  }

  async onLightAutocomplete(query, args) {
    return this.valueAutocomplete(query, this._sensibo.getAllLights() || ['on', 'off'], 'light');
  }

  async onSyncPowerState(state) {
    try {
      this.clearCheckData();
      this.log('onSyncPowerState', state);
      await this._sensibo.syncDeviceState(state === 'on');
      await this.ensureDeviceAvailable();
    } catch (err) {
      await this.handleApiFailure('onSyncPowerState', err);
    } finally {
      this.scheduleCheckData();
    }
  }

  async onUpdateTargetTemperature(value, opts) {
    try {
      this.clearCheckData();
      this.log(`set target temperature: ${this._sensibo.getDeviceId()} -> ${value}`);
      this.queueAcStatePatch({ targetTemperature: value });
      this.log(`set target temperature OK: ${this._sensibo.getDeviceId()} -> ${value}`);
    } catch (err) {
      const message = this.getApiFailureMessage(err);
      this.log('onUpdateTargetTemperature error', message);
      throw message;
    } finally {
      this.scheduleCheckData();
    }
  }

  async onUpdateThermostatMode(value, opts) {
    try {
      this.clearCheckData();
      if (value === 'off' || this._sensibo.checkMode(value)) {
        this.log(`set thermostat mode: ${this._sensibo.getDeviceId()} -> ${value}`);
        if (value === 'off') {
          this.queueAcStatePatch({ on: false });
          await this.setCapabilityValue('se_onoff', false).catch((err) => this.log(err));
          this.homey.app._turnedOffTrigger.trigger(this, { state: 0 }, {}).catch((err) => this.log('Error triggering Turned off:', err));
        } else {
          this.queueAcStatePatch({ on: true, mode: value });
          await this.setCapabilityValue('se_onoff', true).catch((err) => this.log(err));
          this.homey.app._turnedOnTrigger.trigger(this, { state: 1 }, {}).catch((err) => this.log('Error triggering Turned on:', err));
        }
        this.log(`set thermostat OK: ${this._sensibo.getDeviceId()} -> ${value}`);
      }
    } catch (err) {
      const message = this.getApiFailureMessage(err);
      this.log('onUpdateThermostatMode error', message);
      throw message;
    } finally {
      this.scheduleCheckData();
    }
  }

  async onUpdateFanlevel(value, opts) {
    try {
      this.clearCheckData();
      if (this._sensibo.checkFanLevel(value)) {
        this.log(`set fan level: ${this._sensibo.getDeviceId()} -> ${value}`);
        this.queueAcStatePatch({ fanLevel: value });
        this.log(`set fan level OK: ${this._sensibo.getDeviceId()} -> ${value}`);
      }
    } catch (err) {
      const message = this.getApiFailureMessage(err);
      this.log('onUpdateFanlevel error', message);
      throw message;
    } finally {
      this.scheduleCheckData();
    }
  }

  async onUpdateSwing(value, opts) {
    try {
      this.clearCheckData();
      if (this._sensibo.checkSwingMode(value)) {
        this.log(`set swing: ${this._sensibo.getDeviceId()} -> ${value}`);
        this.queueAcStatePatch({ swing: value });
        this.log(`set swing OK: ${this._sensibo.getDeviceId()} -> ${value}`);
      }
    } catch (err) {
      const message = this.getApiFailureMessage(err);
      this.log('onUpdateSwing error', message);
      throw message;
    } finally {
      this.scheduleCheckData();
    }
  }

  async onUpdateHorizontalSwing(value, opts) {
    try {
      this.clearCheckData();
      if (this._sensibo.checkHorizontalSwingMode(value)) {
        this.log(`set horizontal swing: ${this._sensibo.getDeviceId()} -> ${value}`);
        this.queueAcStatePatch({ horizontalSwing: value });
        this.log(`set horizontal swing OK: ${this._sensibo.getDeviceId()} -> ${value}`);
      }
    } catch (err) {
      const message = this.getApiFailureMessage(err);
      this.log('onUpdateHorizontalSwing error', message);
      throw message;
    } finally {
      this.scheduleCheckData();
    }
  }

  async onUpdateClimateReact(value, opts) {
    try {
      this.clearCheckData();
      this.log(`enable/disable Climate React: ${this._sensibo.getDeviceId()} -> ${value}`);
      await this._sensibo.enableClimateReact(value === 'on');
      await this.ensureDeviceAvailable();
    } catch (err) {
      await this.handleApiFailure('onUpdateClimateReact', err);
    } finally {
      this.scheduleCheckData();
    }
  }

  async onUpdatePureBoost(value, opts) {
    try {
      this.clearCheckData();
      this.log(`enable/disable Pure Boost: ${this._sensibo.getDeviceId()} -> ${value}`);
      await this._sensibo.enablePureBoost(value === 'on');
      await this.ensureDeviceAvailable();
    } catch (err) {
      await this.handleApiFailure('onUpdatePureBoost', err);
    } finally {
      this.scheduleCheckData();
    }
  }
};
