'use strict';

const Homey = require('homey');
const Sensibo = require('../lib/sensibo');
const util = require('../lib/util');

module.exports = class BaseDevice extends Homey.Device {
  async onInit() {
    await this.migrate();
    await this.createSensiboApi(this.log);
    this.initAcStateBatching();
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

  initAcStateBatching() {
    this._acStateBatchWindowMs = 500;
    this._pendingAcStatePatch = {};
    this._acStateBatchTimeout = undefined;
    this._acStateBatchResolvers = [];
    this._acStateBatchRejectors = [];
    // Serialize property-only requests across consecutive batches.
    this._acStateSendQueue = Promise.resolve();
    this._lastAcStateCommandAt = 0;
  }

  clearAcStateBatch() {
    if (this._acStateBatchTimeout) {
      this.homey.clearTimeout(this._acStateBatchTimeout);
      this._acStateBatchTimeout = undefined;
    }
    this._pendingAcStatePatch = {};
    this.rejectPendingAcStateBatch(new Error('Device uninitialized before batched acState flush'));
  }

  createAcStateBatchPromise() {
    return new Promise((resolve, reject) => {
      this._acStateBatchResolvers.push(resolve);
      this._acStateBatchRejectors.push(reject);
    });
  }

  resolvePendingAcStateBatch(value, resolvers = this._acStateBatchResolvers) {
    this._acStateBatchResolvers = [];
    this._acStateBatchRejectors = [];
    for (const resolve of resolvers) {
      resolve(value);
    }
  }

  rejectPendingAcStateBatch(err, rejectors = this._acStateBatchRejectors) {
    this._acStateBatchResolvers = [];
    this._acStateBatchRejectors = [];
    for (const reject of rejectors) {
      reject(err);
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
      throw new Error('Device deleted');
    }
    // Keep local state in sync with queued updates so subsequent validations use the effective pending state.
    this._sensibo.updateAcState(patch);
    this._pendingAcStatePatch = { ...this._pendingAcStatePatch, ...patch };
    const batchPromise = this.createAcStateBatchPromise();
    // Attach a no-op rejection handler so fire-and-forget callers do not create unhandled rejections.
    batchPromise.catch(() => {});
    this.scheduleAcStateBatchFlush();
    return batchPromise;
  }

  async sendAcStatePropertyUpdates(patch) {
    // Avoid resending cached mode/temperature when only power or fan level changes.
    // Sensibo supports a PATCH endpoint for each individual AC property.
    for (const [property, value] of Object.entries(patch)) {
      if (this._deleted) {
        throw new Error('Device uninitialized during acState update');
      }
      // Pace requests (including consecutive batches) to reduce Sensibo API 429 errors.
      const elapsed = Date.now() - this._lastAcStateCommandAt;
      const delay = Math.max(0, 750 - elapsed);
      if (delay > 0) {
        await new Promise((resolve) => this.homey.setTimeout(resolve, delay));
      }
      if (this._deleted) {
        throw new Error('Device uninitialized during acState update');
      }
      this._lastAcStateCommandAt = Date.now();
      await this._sensibo.setAcProperty(property, value);
    }
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
      const operation = this._acStateSendQueue.then(() => this.sendAcStatePropertyUpdates(patch));
      // Keep subsequent batches working after a failed request.
      this._acStateSendQueue = operation.catch(() => {});
      await operation;
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
    return 'Unknown API error';
  }

  isApiFailureError(err) {
    return !!(err && (err.apiMessage || err.status || err.responseData));
  }

  async setUnavailableFromApiError(err) {
    const message = this.getApiFailureMessage(err);
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

  isInitialized() {
    return this._initialized;
  }

  async createSensiboApi(logger) {
    this._sensibo = new Sensibo({
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

  async onRemoteCapabilitiesReceived(capabilities) {
    // Adjust modes for thermostat_mode
    if (capabilities.modes !== undefined && this.hasCapability('thermostat_mode') === true) {
      const defaultModes = ['auto', 'heat', 'cool', 'off'];
      // Modes reported by the remote device
      const remoteModes = util.getModes(capabilities) || [];

      const availableModes = [...defaultModes, ...remoteModes.filter((mode) => !defaultModes.includes(mode))];

      // Fetch current options (may throw if not set yet, so wrap safely)
      let currentOptions;
      try {
        currentOptions = this.getCapabilityOptions('thermostat_mode');
      } catch (err) {
        currentOptions = { values: [] };
      }

      // Update only if there are changes on thermostat_mode modes
      if (
        !util.arraysEqualIgnoreOrder(
          availableModes,
          currentOptions.values.map((option) => option.id)
        )
      ) {
        const newOptions = {
          values: availableModes.map((mode) => ({
            id: mode,
            title: this.homey.__(`thermostat_mode.${mode}`)
          }))
        };
        await this.setCapabilityOptions('thermostat_mode', newOptions);
        this.log('Updated thermostat_mode options ->', availableModes);
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
    this.homey.scheduleCheckData(5);
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
      if (result.measurements) {
        await this.updateIfChanged('measure_temperature', result.measurements.temperature);
        await this.updateIfChanged('measure_humidity', result.measurements.humidity);
        if (result.measurements.batteryVoltage) {
          if (result.productModel === 'motion_sensor') {
            await this.updateIfChanged('measure_battery', Math.round(3000 / result.measurements.batteryVoltage) * 100);
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
              this.homey.app._offlineTrigger.trigger(
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

  async scheduleCheckData(seconds) {
    if (this._deleted) {
      return;
    }
    this.clearCheckData();
    let interval = seconds;
    if (!interval) {
      const settings = await this.getSettings();
      interval = settings.Polling_Interval || 30;
    }
    this.curTimeout = this.homey.setTimeout(this.checkData.bind(this), interval * 1000);
  }

  async checkData() {}

  clearTimer() {
    if (this.curTimer) {
      this.homey.clearTimeout(this.curTimer);
      this.curTimer = undefined;
    }
  }

  async scheduleTimer(seconds) {
    if (this._deleted) {
      return;
    }
    this.clearTimer();
    this.curTimer = this.homey.setTimeout(this.onTimerFired.bind(this), seconds * 1000 + 1);
  }

  async onTimerFired() {
    if (this._deleted) {
      return;
    }
    try {
      this.clearTimer();
      this.homey.app._timerFiredTrigger.trigger(this, { state: 1 }, {});
      this.log(`Timer fired for: ${this._sensibo.getDeviceId()}`);
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
      this.homey.app._turnedOnTrigger.trigger(this, { state: 1 }, {});
      this.log(`turned on OK: ${this._sensibo.getDeviceId()}`);
    } catch (err) {
      let message = err;
      if (err.response.data.message !== undefined) {
        message = err.response.data.message;
      }
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
      this.homey.app._turnedOffTrigger.trigger(this, { state: 0 }, {});
      this.log(`turned off OK: ${this._sensibo.getDeviceId()}`);
    } catch (err) {
      let message = err;
      if (err.response.data.message !== undefined) {
        message = err.response.data.message;
      }
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
      let message = err;
      if (err.response.data.message !== undefined) {
        message = err.response.data.message;
      }
      this.log('onActionSetMode error', message);
      throw message;
    } finally {
      this.scheduleCheckData();
    }
  }

  async onModeAutocomplete(query, args) {
    const modes = this._sensibo.getModes() || ['cool', 'heat', 'fan', 'auto', 'dry'];
    return Promise.resolve(
      modes
        .map((mode) => {
          return {
            id: mode,
            name: mode[0].toUpperCase() + mode.substr(1).toLowerCase()
          };
        })
        .filter((result) => {
          return result.name.toLowerCase().indexOf(query.toLowerCase()) > -1;
        })
    );
  }

  async onActionSetFanLevel(fanLevel) {
    await this.onUpdateFanlevel(fanLevel);
    if (this.hasCapability('se_fanlevel')) {
      await this.setCapabilityValue('se_fanlevel', fanLevel).catch((err) => this.log(err));
    }
  }

  async onFanLevelAutocomplete(query, args) {
    const fanLevels = this._sensibo.getAllFanLevels() || ['auto', 'high', 'medium', 'low'];
    return Promise.resolve(
      fanLevels
        .map((fanLevel) => {
          let name = fanLevel[0].toUpperCase() + fanLevel.substr(1).toLowerCase();
          name = name.replace('_', ' ');
          return {
            id: fanLevel,
            name
          };
        })
        .filter((result) => {
          return result.name.toLowerCase().indexOf(query.toLowerCase()) > -1;
        })
    );
  }

  async onActionSetSwing(swing) {
    await this.onUpdateSwing(swing);
    if (this.hasCapability('se_fandirection')) {
      await this.setCapabilityValue('se_fandirection', swing).catch((err) => this.log(err));
    }
  }

  async onSwingAutocomplete(query, args) {
    const items = this._sensibo.getAllSwings() || ['stopped', 'fixedBottom', 'fixedTop', 'rangeTop', 'rangeFull'];
    return Promise.resolve(
      items
        .map((item) => {
          let name = item[0].toUpperCase() + item.substr(1).toLowerCase();
          name = name.replace('_', ' ');
          return {
            id: item,
            name
          };
        })
        .filter((result) => {
          return result.name.toLowerCase().indexOf(query.toLowerCase()) > -1;
        })
    );
  }

  async onActionSetHorizontalSwing(horizontalSwing) {
    await this.onUpdateHorizontalSwing(horizontalSwing);
    if (this.hasCapability('se_horizontal_swing')) {
      await this.setCapabilityValue('se_horizontal_swing', horizontalSwing).catch((err) => this.log(err));
    }
  }

  async onHorizontalSwingAutocomplete(query, args) {
    const items = this._sensibo.getAllHorizontalSwings() || ['stopped', 'fixedLeft', 'fixedRight', 'rangeCenter', 'rangeFull'];
    return Promise.resolve(
      items
        .map((item) => {
          let name = item[0].toUpperCase() + item.substr(1).toLowerCase();
          name = name.replace('_', ' ');
          return {
            id: item,
            name
          };
        })
        .filter((result) => {
          return result.name.toLowerCase().indexOf(query.toLowerCase()) > -1;
        })
    );
  }

  async onActionClimateReact(enabled) {
    await this.onUpdateClimateReact(enabled);
    if (this.hasCapability('se_climate_react')) {
      await this.setCapabilityValue('se_climate_react', enabled).catch((err) => this.log(err));
    }
  }

  async onActionPureBoost(enabled) {
    await this.onUpdatePureBoost(enabled);
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
      this.homey.app._timerDeletedTrigger.trigger(this, { homey: true }, {});
    } catch (err) {
      await this.handleApiFailure('onDeleteTimer', err);
    } finally {
      this.scheduleCheckData();
    }
  }

  async onSetTimer(minutesFromNow, on, mode, fanLevel, targetTemperature) {
    try {
      this.log('onSetTimer', minutesFromNow, on, on === 'on', mode, fanLevel, targetTemperature);
      this.clearCheckData();
      const newAcState = {
        on: on !== 'nop' ? on === 'on' : undefined,
        mode: mode !== 'nop' ? mode : undefined,
        fanLevel: fanLevel !== 'nop' ? fanLevel : undefined,
        targetTemperature: targetTemperature >= 10 ? targetTemperature : undefined
      };
      if (minutesFromNow <= 0) {
        throw new Error('Minutes from now must be specified.');
      }
      if (minutesFromNow > 1440) {
        throw new Error('Minutes from now cannot be larger than 1440.');
      }
      if (newAcState.on === undefined && newAcState.mode === undefined && newAcState.fanLevel === undefined && newAcState.targetTemperature === undefined) {
        throw new Error('At least one parameter must be specified.');
      }
      await this._sensibo.setCurrentTimer(minutesFromNow, newAcState);
      await this.ensureDeviceAvailable();
      this._hasTimer = true;
      this._hasTimerEnabled = true;
      this.homey.app._timerCreatedTrigger.trigger(this, { homey: true }, {});
    } catch (err) {
      if (this.isApiFailureError(err)) {
        await this.handleApiFailure('onSetTimer', err);
      }
      const message = this.getApiFailureMessage(err);
      this.log('onSetTimer error', message);
      throw message;
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
      let message = err;
      if (err.response.data.message !== undefined) {
        message = err.response.data.message;
      }
      this.log('onControlLight error', message);
      throw message;
    } finally {
      this.scheduleCheckData();
    }
  }

  async onLightAutocomplete(query, args) {
    const items = this._sensibo.getAllLights() || ['on', 'off'];
    return Promise.resolve(
      items
        .map((item) => {
          let name = item[0].toUpperCase() + item.substr(1).toLowerCase();
          name = name.replace('_', ' ');
          return {
            id: item,
            name
          };
        })
        .filter((result) => {
          return result.name.toLowerCase().indexOf(query.toLowerCase()) > -1;
        })
    );
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
      let message = err;
      if (err.response.data.message !== undefined) {
        message = err.response.data.message;
      }
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
          this.homey.app._turnedOffTrigger.trigger(this, { state: 0 }, {});
        } else {
          this.queueAcStatePatch({ on: true, mode: value });
          await this.setCapabilityValue('se_onoff', true).catch((err) => this.log(err));
          this.homey.app._turnedOnTrigger.trigger(this, { state: 1 }, {});
        }
        this.log(`set thermostat OK: ${this._sensibo.getDeviceId()} -> ${value}`);
      }
    } catch (err) {
      let message = err;
      if (err.response.data.message !== undefined) {
        message = err.response.data.message;
      }
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
      let message = err;
      if (err.response.data.message !== undefined) {
        message = err.response.data.message;
      }
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
      let message = err;
      if (err.response.data.message !== undefined) {
        message = err.response.data.message;
      }
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
      let message = err;
      if (err.response.data.message !== undefined) {
        message = err.response.data.message;
      }
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
