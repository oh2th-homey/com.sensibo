'use strict';

const BaseDriver = require('../BaseDriver');

module.exports = class SensiboDriver extends BaseDriver {

  driverName = () => 'SensiboDriver';

  filterProductModel = (device) => {
    // sky, skyv2 = Sensibo Sky
    // skyplus = Sensibo Air
    // airq = Sensibo AirQ and Sensibo Air Pro
    return device.productModel && (device.productModel.includes('sky') || device.productModel.includes('airq'));
  };

};
