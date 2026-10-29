'use strict';

const Homey = require('homey');
const Sensibo = require('../lib/sensibo');

module.exports = class BaseDriver extends Homey.Driver {
  onInit() {
    this.log(`${this.driverName()} driver has been initialized`);
  }

  driverName = () => {
    throw new Error('Not implemented');
  };

  filterProductModel = (device) => {
    throw new Error('Not implemented');
  };

  filterDevices = (result, apikey) => {
    const filtered = result.filter((device) => this.filterProductModel(device));
    if (filtered.length === 0) {
      throw new Error(this.homey.__('errors.no_devices'));
    }
    return filtered.map((device) => ({
      name: this.deviceName(device),
      data: {
        id: device.id
      },
      store: {
        apikey
      }
    }));
  };

  deviceName = (device) => `Sensibo ${device.room.name}`;

  async onPair(session) {
    let apikey;
    let sensibo;

    session.setHandler('apikey_input', async (data) => {
      apikey = data.apikey;
      sensibo = new Sensibo({
        apikey,
        logger: this.log
      });
      await session.showView('list_devices');
    });

    session.setHandler('list_devices', async () => {
      let devices;
      try {
        devices = await sensibo.getAllDevices();
      } catch (err) {
        this.log('onPair getAllDevices failed:', err);
        throw new Error(this.homey.__('errors.failed_to_retrieve_devices'));
      }
      if (!devices || !devices.result) {
        throw new Error(this.homey.__('errors.failed_to_retrieve_devices'));
      }
      return this.filterDevices(devices.result, apikey);
    });
  }

  async onRepair(session, device) {
    let apikey;
    let sensibo;

    session.setHandler('apikey_input', async (data) => {
      apikey = data.apikey;
      sensibo = new Sensibo({
        apikey,
        logger: this.log
      });

      let devices;
      try {
        devices = await sensibo.getAllDevices();
      } catch (err) {
        this.log('onRepair getAllDevices failed:', err);
        throw new Error(this.homey.__('errors.failed_to_retrieve_devices'));
      }
      if (!devices || !devices.result) {
        throw new Error(this.homey.__('errors.failed_to_retrieve_devices'));
      }
      if (devices.result.length === 0) {
        throw new Error(this.homey.__('errors.no_devices'));
      }
      await this.updateApiKeys(device, apikey, devices.result);
      try {
        const driverClass = this.manifest.class;
        if (driverClass && device.getClass() !== driverClass) {
          await device.setClass(driverClass);
          this.log(`onRepair migrated device class to ${driverClass}`);
        }
      } catch (err) {
        this.log('onRepair device class migration failed:', err);
      }
      await device.setAvailable();
      this.log('onRepair OK');
      this.homey.app.scheduleCheckData(5);
      await session.done();
      return true;
    });
  }

  async updateApiKeys(repairedDevice, apikey, pods) {
    // All devices of the account the new key belongs to, plus devices still using the replaced key
    const accountIds = new Set();
    for (const pod of pods) {
      accountIds.add(pod.id);
      for (const motionSensor of pod.motionSensors || []) {
        accountIds.add(motionSensor.id);
      }
    }
    const oldApiKey = repairedDevice.getApiKey();
    const drivers = this.homey.drivers.getDrivers();
    for (const driver of Object.values(drivers)) {
      for (const device of driver.getDevices()) {
        if (!device.updateApiKey || device.getApiKey() === apikey) {
          continue;
        }
        const isSameKey = !!oldApiKey && device.getApiKey() === oldApiKey;
        if (device === repairedDevice || isSameKey || accountIds.has(device.getData().id)) {
          try {
            await device.updateApiKey(apikey);
            this.log(`onRepair updated API key for ${device.getName()}`);
          } catch (err) {
            this.log('onRepair updateApiKey failed:', err);
          }
        }
      }
    }
  }
};
