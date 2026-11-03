'use strict';

const BaseDriver = require('../BaseDriver');

module.exports = class SensiboPureDriver extends BaseDriver {

  driverName = () => 'SensiboPureDriver';

  filterProductModel = (device) => {
    return device.productModel === 'pure';
  };

  deviceName = (device) => `Sensibo Pure ${device.room.name}`;

};
