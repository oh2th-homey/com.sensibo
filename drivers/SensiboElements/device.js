'use strict';

const BaseDevice = require('../BaseDevice');

module.exports = class SensiboElementsDevice extends BaseDevice {

	async migrate() {
		try {
			if (!this.hasCapability('se_light')) {
				await this.addCapability('se_light');
			}
			this.log('Migration OK');
		} catch (err) {
			this.log('Migration failed', err);
		}
	}

	async registerCapabilityListeners() {
		if (this.hasCapability('se_light')) {
			this.registerCapabilityListener('se_light', async (value) => {
				await this.onControlLight(value);
			});
		}
	}

	deviceName = () => 'SensiboElementsDevice';

};
