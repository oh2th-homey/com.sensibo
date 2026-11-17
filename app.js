'use strict';

const Homey = require('homey');
const Sensibo = require('./lib/sensibo');
const { randomDelay, maskApiKey } = require('./lib/util');

// Seconds between polls of an API key while its event stream is open: not every value has an event
const STREAM_POLL_INTERVAL = 900;
// Seconds before a closed event stream is opened again, doubled after each failure
const STREAM_RETRY_MIN = 5;
const STREAM_RETRY_MAX = 300;

class SensiboApp extends Homey.App {
  async onInit() {
    this.myAppIdVersion = `${this.homey.manifest.id}/${this.homey.manifest.version}`;
    this.log(`${this.myAppIdVersion} - onInit - starting...`);
    this.streamPollInterval = STREAM_POLL_INTERVAL;
    // One event stream per API key, and the last polled data of each device for the events to update
    this._streams = new Map();
    this._podData = new Map();
    await this._initFlows();
    await this.createSensiboApi();
    await this.scheduleCheckData(15);
    this.log(`${this.myAppIdVersion} - onInit - started.`);
  }

  async onUninit() {
    this._deleted = true;
    this.clearCheckData();
    this.syncStreams(new Set());
  }

  async _initFlows() {
    this._turnedOnTrigger = this.homey.flow.getDeviceTriggerCard('se_onoff_true');
    this._turnedOffTrigger = this.homey.flow.getDeviceTriggerCard('se_onoff_false');
    this._offlineTrigger = this.homey.flow.getDeviceTriggerCard('se_offline');
    this._acStateChangedTrigger = this.homey.flow.getDeviceTriggerCard('se_ac_state_changed');
    this._climateReactChangedTrigger = this.homey.flow.getDeviceTriggerCard('se_climate_react_changed');
    this._climateReactSettingsChangedTrigger = this.homey.flow.getDeviceTriggerCard('se_climate_react_settings_changed');
    this._triggerAirQualityChanged = this.homey.flow.getDeviceTriggerCard('air_quality_changed');
    this._timerCreatedTrigger = this.homey.flow.getDeviceTriggerCard('se_timer_created');
    this._timerFiredTrigger = this.homey.flow.getDeviceTriggerCard('se_timer_fired');
    this._timerDeletedTrigger = this.homey.flow.getDeviceTriggerCard('se_timer_deleted');
    this._filterAlarmTrigger = this.homey.flow.getDeviceTriggerCard('alarm_filter');

    this.homey.flow.getConditionCard('se_onoff_is_on').registerRunListener((args, state) => args.device.getCapabilityValue('se_onoff'));

    this.homey.flow.getConditionCard('se_climate_react_enabled').registerRunListener((args, state) => args.device.getCapabilityValue('se_climate_react') === 'on');

    this.homey.flow.getConditionCard('se_timer_enabled').registerRunListener((args, state) => args.device.isTimerEnabled());

    this.homey.flow.getConditionCard('light_on').registerRunListener((args, state) => args.device.isLightOn());

    this.homey.flow.getActionCard('sensibo_on').registerRunListener((args, state) => args.device.onActionTurnOn());

    this.homey.flow.getActionCard('sensibo_off').registerRunListener((args, state) => args.device.onActionTurnOff());

    this.homey.flow.getActionCard('sensibo_mode').registerRunListener((args, state) => args.device.onActionSetMode(args.mode));

    this.homey.flow
      .getActionCard('sensibo_mode2')
      .registerRunListener((args, state) => args.device.onActionSetMode(args.mode.id))
      .getArgument('mode')
      .registerAutocompleteListener((query, args) => args.device.onModeAutocomplete(query, args));

    this.homey.flow.getActionCard('sensibo_fanlevel').registerRunListener((args, state) => args.device.onActionSetFanLevel(args.fanLevel));

    this.homey.flow
      .getActionCard('sensibo_fanlevel2')
      .registerRunListener((args, state) => args.device.onActionSetFanLevel(args.fanLevel.id))
      .getArgument('fanLevel')
      .registerAutocompleteListener((query, args) => args.device.onFanLevelAutocomplete(query, args));

    this.homey.flow.getActionCard('sensibo_fandirection').registerRunListener((args, state) => args.device.onActionSetSwing(args.fanDirection));

    this.homey.flow
      .getActionCard('sensibo_swing')
      .registerRunListener((args, state) => args.device.onActionSetSwing(args.swing.id))
      .getArgument('swing')
      .registerAutocompleteListener((query, args) => args.device.onSwingAutocomplete(query, args));

    this.homey.flow
      .getActionCard('sensibo_horizontal_swing')
      .registerRunListener((args, state) => args.device.onActionSetHorizontalSwing(args.horizontalSwing.id))
      .getArgument('horizontalSwing')
      .registerAutocompleteListener((query, args) => args.device.onHorizontalSwingAutocomplete(query, args));

    this.homey.flow.getActionCard('sensibo_cr').registerRunListener((args, state) => args.device.onActionClimateReact(args.enabled));

    for (const side of ['high', 'low']) {
      const card = this.homey.flow
        .getActionCard(side === 'high' ? 'sensibo_cr_above' : 'sensibo_cr_below')
        .registerRunListener((args, state) => args.device.onActionSetClimateReactRule(side, args));
      card.getArgument('mode').registerAutocompleteListener((query, args) => args.device.withUnchangedOption(query, args.device.onModeAutocomplete(query, args)));
      card.getArgument('fanLevel').registerAutocompleteListener((query, args) => args.device.withUnchangedOption(query, args.device.onFanLevelAutocomplete(query, args)));
      card.getArgument('swing').registerAutocompleteListener((query, args) => args.device.withUnchangedOption(query, args.device.onSwingAutocomplete(query, args)));
      card
        .getArgument('horizontalSwing')
        .registerAutocompleteListener((query, args) => args.device.withUnchangedOption(query, args.device.onHorizontalSwingAutocomplete(query, args)));
    }

    this.homey.flow.getActionCard('sensibo_pureboost').registerRunListener((args, state) => args.device.onUpdatePureBoost(args.enabled));

    this.homey.flow.getActionCard('sensibo_delete_timer').registerRunListener((args, state) => args.device.onDeleteTimer());

    this.homey.flow.getActionCard('sensibo_set_timer').registerRunListener((args, state) => args.device.onSetTimer(args.minutesFromNow, args.on, args.mode, args.fanLevel, args.targetTemperature));

    this.homey.flow.getActionCard('sensibo_set_timer_pure').registerRunListener((args, state) => args.device.onSetTimer(args.minutesFromNow, args.on, 'nop', args.fanLevel, 0));

    this.homey.flow.getActionCard('sensibo_light').registerRunListener((args, state) => args.device.onControlLight(args.state));

    this.homey.flow
      .getActionCard('sensibo_light2')
      .registerRunListener((args, state) => args.device.onControlLight(args.state.id))
      .getArgument('state')
      .registerAutocompleteListener((query, args) => args.device.onLightAutocomplete(query, args));

    this.homey.flow.getActionCard('sensibo_sync_state').registerRunListener((args, state) => args.device.onSyncPowerState(args.state));
  }

  async createSensiboApi() {
    this._sensibo = new Sensibo({
      homey: this.homey,
      logger: this.log
    });
  }

  clearCheckData() {
    if (this.curTimeout) {
      this.homey.clearTimeout(this.curTimeout);
      this.curTimeout = undefined;
    }
  }

  scheduleCheckData(interval = 60) {
    if (this._deleted) {
      return;
    }
    this.clearCheckData();
    // this.log(`New polling in ${interval} seconds`);
    this.curTimeout = this.homey.setTimeout(() => {
      this.checkData().catch((err) => this.log('checkData error', err));
    }, interval * 1000);
  }

  async checkData() {
    if (this._deleted) {
      return;
    }
    let pollingInterval = 60;
    this.log('Checking Sensibo data...');
    try {
      this.clearCheckData();
      const { apiKeys, devices, pInterval } = this.getSensiboDevices();
      pollingInterval = pInterval;
      this.syncStreams(apiKeys);
      for (const apikey of apiKeys) {
        const stream = this._streams.get(apikey);
        const pollNow = stream.pollNow;
        // With an open event stream the API tells when a device changes, so a slow poll is enough
        if (stream.open && !pollNow && Date.now() - stream.polledAt < STREAM_POLL_INTERVAL * 1000) {
          continue;
        }
        if (!pollNow) {
          await randomDelay(this.homey, 2, 10);
        }
        stream.pollNow = false;
        stream.polledAt = Date.now();
        try {
          const data = await this._sensibo.getAllDeviceInfo(apikey);
          await this.onDevicesDataReceived(data, devices);
        } catch (err) {
          const names = Array.from(devices.values())
            .filter((device) => device.getApiKey() === apikey)
            .map((device) => device.getName());
          this.log(`checkData api failed for key ${maskApiKey(apikey)} used by:`, names, err);
        }
      }
    } catch (err) {
      this.log('checkData', err);
    } finally {
      this.scheduleCheckData(pollingInterval);
    }
  }

  isStreamOpen(apiKey) {
    const stream = this._streams.get(apiKey);
    return !!stream && stream.open;
  }

  // Opens an event stream for each API key in use and closes the streams of keys that are gone
  syncStreams(apiKeys) {
    for (const [apiKey, stream] of this._streams) {
      if (!apiKeys.has(apiKey)) {
        stream.closed = true;
        this.homey.clearTimeout(stream.retryTimeout);
        if (stream.controller) {
          stream.controller.abort();
        }
        this._streams.delete(apiKey);
      }
    }
    for (const apiKey of apiKeys) {
      if (!this._streams.has(apiKey)) {
        const stream = {
          open: false, closed: false, failures: 0, polledAt: 0, pollNow: false
        };
        this._streams.set(apiKey, stream);
        this.openStream(apiKey, stream);
      }
    }
  }

  // Keeps the event stream of an API key open. While it is not open, the devices are polled as before.
  openStream(apiKey, stream) {
    if (this._deleted || stream.closed) {
      return;
    }
    stream.controller = new AbortController();
    this._sensibo
      .streamEvents(apiKey, (name, data) => this.onStreamEvent(apiKey, stream, name, data), stream.controller.signal)
      .then(
        () => 0,
        (err) => {
          if (!stream.closed) {
            this.log(`Event stream failed for key ${maskApiKey(apiKey)}:`, err.message);
          }
          // A wrong API key does not get better with a fast retry
          return err.status === 401 || err.status === 403 ? STREAM_RETRY_MAX : err.retryAfter || 0;
        }
      )
      .then((retryAfter) => {
        if (this._deleted || stream.closed) {
          return;
        }
        if (stream.open) {
          stream.open = false;
          this.onStreamClosed(apiKey);
        }
        stream.failures++;
        const delay = Math.max(Math.min(STREAM_RETRY_MIN * 2 ** Math.min(stream.failures - 1, 6), STREAM_RETRY_MAX), retryAfter);
        // The random part keeps the clients apart after a restart of the API
        stream.retryTimeout = this.homey.setTimeout(() => this.openStream(apiKey, stream), delay * (1 + Math.random()) * 1000);
      })
      .catch((err) => this.log('openStream', err));
  }

  // hello: the stream is open. measurements: new values of a device or a Room Sensor.
  // changed: something else changed on the device. resync: the API closes the stream.
  async onStreamEvent(apiKey, stream, name, data) {
    stream.failures = 0;
    if (name === 'hello') {
      stream.open = true;
      this.log(`Event stream open for key ${maskApiKey(apiKey)}`);
    } else if (name === 'measurements') {
      if (await this.onStreamMeasurements(data)) {
        return;
      }
    } else if (name === 'changed') {
      const device = this.getDevice(data.id);
      // The AC states of the device give the reason of the change; no fields means that any field can be different
      if (device && (!Array.isArray(data.fields) || data.fields.length === 0 || data.fields.includes('acState'))) {
        device.scheduleCheckData(1);
      }
    } else {
      return;
    }
    stream.pollNow = true;
    this.scheduleCheckData(1);
  }

  onStreamClosed(apiKey) {
    this.log(`Event stream closed for key ${maskApiKey(apiKey)}`);
    const drivers = this.homey.drivers.getDrivers();
    Object.keys(drivers).forEach((key) => {
      drivers[key].getDevices().forEach((device) => {
        // Back to the polling interval of the device
        if (!!device.isInitialized && device.isInitialized() && device.getApiKey() === apiKey) {
          device.scheduleCheckData();
        }
      });
    });
  }

  // Puts the measurements of an event into the last polled data and gives them to the devices.
  // Returns false when the device of the event is not in the polled data.
  async onStreamMeasurements(data) {
    const pod = this._podData.get(data.podId || data.id);
    if (!pod || !pod.measurements || !data.measurements) {
      return false;
    }
    if (data.podId) {
      const sensor = (pod.motionSensors || []).find((motionSensor) => motionSensor.id === data.id);
      if (!sensor) {
        return false;
      }
      sensor.measurements = { ...sensor.measurements, ...data.measurements };
      // The AC shows the values of a Room Sensor that is its primary sensor
      if (pod.mainMeasurementsSensor && pod.mainMeasurementsSensor.id === data.id) {
        pod.mainMeasurementsSensor.measurements = sensor.measurements;
      }
      await this.onMeasurementsReceived(sensor);
    } else {
      pod.measurements = { ...pod.measurements, ...data.measurements };
    }
    await this.onMeasurementsReceived(pod);
    return true;
  }

  async onMeasurementsReceived(resultItem) {
    try {
      const device = this.getDevice(resultItem.id);
      if (device) {
        await device.onMeasurementsReceived(resultItem);
      }
    } catch (err) {
      this.log('onMeasurementsReceived', err);
    }
  }

  getDevice(id) {
    const drivers = this.homey.drivers.getDrivers();
    for (const key of Object.keys(drivers)) {
      const device = drivers[key].getDevices().find((item) => item.getData().id === id);
      if (device && !!device.isInitialized && device.isInitialized()) {
        return device;
      }
    }
    return undefined;
  }

  getSensiboDevices() {
    const apiKeys = new Set();
    const devices = new Map();
    let pInterval = 60;
    const drivers = this.homey.drivers.getDrivers();
    Object.keys(drivers).forEach((key) => {
      const driver = drivers[key];
      driver.getDevices().forEach((device) => {
        if (!!device.isInitialized && device.isInitialized() && !!device.getApiKey) {
          const apiKey = device.getApiKey();
          if (apiKey) {
            devices.set(device.getData().id, device);
            apiKeys.add(apiKey);
          }
        }
        const pi = device.getSetting('Polling_Interval');
        if (pi && pi < pInterval && pi >= 15) {
          pInterval = pi;
        }
      });
    });

    this.log('Got Sensibo devices:', Array.from(apiKeys).map(maskApiKey), Array.from(devices.keys()), pInterval);
    return { apiKeys, devices, pInterval };
  }

  async onDevicesDataReceived(data, devices) {
    if (!data || !data.result) {
      return;
    }
    for (const resultItem of data.result) {
      // A copy, because the device changes the data that it receives
      this._podData.set(resultItem.id, structuredClone(resultItem));
      await this.onDeviceInfoReceived(resultItem, devices);
      if (resultItem.motionSensors) {
        for (const msResultItem of resultItem.motionSensors) {
          await this.onDeviceInfoReceived(msResultItem, devices);
        }
      }
    }
  }

  async onDeviceInfoReceived(resultItem, devices) {
    try {
      if (resultItem.id) {
        const device = devices.get(resultItem.id);
        if (device && device.onDeviceInfoReceived) {
          // this.log(`Received data for device: ${device.getData().id}: `, resultItem);
          await device.onDeviceInfoReceived(resultItem);
        }
      }
    } catch (err) {
      this.log('onDeviceInfoReceived', err);
    }
  }
}

module.exports = SensiboApp;
