'use strict';

const BaseDriver = require('../BaseDriver');

module.exports = class SensiboElementsDriver extends BaseDriver {

  driverName = () => 'SensiboElementsDriver';

  filterProductModel = (device) => {
    return device.productModel === 'elements';
  };

  deviceName = (device) => `Sensibo Elements ${device.room.name}`;

};
