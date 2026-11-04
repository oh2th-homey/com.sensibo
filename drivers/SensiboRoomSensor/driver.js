'use strict';

const BaseDriver = require('../BaseDriver');
const { roomSensorName } = require('../../lib/util');

module.exports = class SensiboRoomSensorDriver extends BaseDriver {

  driverName = () => 'SensiboRoomSensorDriver';

  filterDevices = (result, apikey) => {
    const mainDevices = result
      .filter((device) => !!device.room)
      .map((device) => ({
        id: device.id,
        room: device.room,
      }))
      .reduce((map, obj) => {
        map[obj.id] = obj;
        return map;
      }, {});

    const filtered = result
      .filter((device) => !!device.motionSensors)
      .flatMap((device) => device.motionSensors);

    if (filtered.length === 0) {
      throw new Error(this.homey.__('errors.no_devices'));
    }

    let dev = 0;
    return filtered
      .map((device) => {
        const mainDevice = mainDevices[device.parentDeviceUid];
        const room = mainDevice ? `${mainDevice.room.name} ` : '';
        return {
          name: roomSensorName(device, `Sensibo Room Sensor ${room}(${++dev})`),
          data: {
            id: device.id,
          },
          store: {
            apikey,
          },
        };
      });
  };

};
