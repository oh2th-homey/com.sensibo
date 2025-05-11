'use strict';

const BaseDevice = require('../BaseDevice');
const { randomDelay } = require('../../lib/util');

module.exports = class SensiboDevice extends BaseDevice {

	async onInit() {
		await super.onInit();
		await this.scheduleCheckData(6);
	}

	async migrate() {
		try {
			if (!this.getStoreValue('apikey')) {
				const apikey = this.homey.settings.get('apikey');
				await this.setStoreValue('apikey', apikey);
				this.log('Copied the apikey to device store');
			}
		} catch (err) {
			this.log('Copying of the apikey failed', err);
		}

		try {
			if (!this.hasCapability('se_fanlevel')) {
				await this.addCapability('se_fanlevel');
			}
			if (!this.hasCapability('se_fandirection')) {
				await this.addCapability('se_fandirection');
			}
			if (!this.hasCapability('se_last_seen')) {
				await this.addCapability('se_last_seen');
			}
			if (!this.hasCapability('se_last_seen_seconds')) {
				await this.addCapability('se_last_seen_seconds');
			}
			if (!this.hasCapability('se_climate_react')) {
				await this.addCapability('se_climate_react');
			}
			if (!this.hasCapability('se_horizontal_swing')) {
				await this.addCapability('se_horizontal_swing');
			}
			this.log('Migration OK');
		} catch (err) {
			this.log('Migration failed', err);
		}
	}

	async registerCapabilityListeners() {
		this.registerCapabilityListener('target_temperature', (value, opts) => {
			return this.onUpdateTargetTemperature(value, opts);
		});

		if (this.hasCapability('thermostat_mode')) {
			this.registerCapabilityListener('thermostat_mode', (value, opts) => {
				return this.onUpdateThermostatMode(value, opts);
			});
		}

		if (this.hasCapability('se_fanlevel')) {
			this.registerCapabilityListener('se_fanlevel', (value, opts) => {
				return this.onUpdateFanlevel(value, opts);
			});
		}

		if (this.hasCapability('se_fandirection')) {
			this.registerCapabilityListener('se_fandirection', (value, opts) => {
				return this.onUpdateSwing(value, opts);
			});
		}

		if (this.hasCapability('se_horizontal_swing')) {
			this.registerCapabilityListener('se_horizontal_swing', (value, opts) => {
				return this.onUpdateHorizontalSwing(value, opts);
			});
		}

		if (this.hasCapability('se_climate_react')) {
			this.registerCapabilityListener('se_climate_react', (value, opts) => {
				return this.onUpdateClimateReact(value, opts);
			});
		}

		this.registerCapabilityListener('se_onoff', async (value, opts) => {
			return value ? this.onActionTurnOn({ device: this }) : this.onActionTurnOff({ device: this });
		});
	}

	deviceName = () => 'SensiboDevice';

	async checkData() {
		if (this._deleted) {
			return;
		}
		try {
			this.clearCheckData();
			if (this.hasCapability('se_climate_react')) {
				this.log(`Fetching AC state for: ${this._sensibo.getDeviceId()}`);
				await randomDelay(1, 3);
				const acStatesData = await this._sensibo.getAcStates();
				await this.onAcStatesReceived(acStatesData);
				await randomDelay(2, 10);
				const climateReactSettings = await this._sensibo.getClimateReactSettings();
				await this.onClimateReactSettingsReceived(climateReactSettings);
			}
		} catch (err) {
			this.log('checkData device', err);
		} finally {
			this.scheduleCheckData();
		}
	}

	async onAcStatesReceived(data) {
		if (data.data) {
			const curAcStates = data.data.result;
			this.log(`AC States for: ${this._sensibo.getDeviceId()}`, curAcStates.length, curAcStates.map((acs) => acs.id));
			if (this._lastAcStatesIds) {
				for (const anAcState of curAcStates) {
					if (this._lastAcStatesIds[anAcState.id]) break;
					const payload = {
						status: anAcState.status,
						reason: anAcState.reason,
						on: anAcState.acState.on,
						fanLevel: anAcState.acState.fanLevel ? anAcState.acState.fanLevel : '',
						targetTemperature: anAcState.acState.targetTemperature,
						temperatureUnit: anAcState.acState.temperatureUnit ? anAcState.acState.temperatureUnit : '',
						mode: anAcState.acState.mode ? anAcState.acState.mode : '',
						swing: anAcState.acState.swing ? anAcState.acState.swing : '',
						failureReason: anAcState.failureReason ? anAcState.failureReason : '',
					};
					this.homey.app._acStateChangedTrigger
						.trigger(this, payload, {})
						.then(() => this.log(`AC State change triggered: ${this._sensibo.getDeviceId()}`, anAcState.id, payload))
						.catch((err) => this.log('Error triggering AC State change:', err));
				}
			}
			this._lastAcStatesIds = curAcStates.reduce((map, obj) => {
				map[obj.id] = obj.id;
				return map;
			}, {});
		}
	}

	async onClimateReactSettingsReceived(data) {
		if (data.data) {
			const { result } = data.data;
			if (result.enabled !== undefined) {
				this.log(`Climate React settings for: ${this._sensibo.getDeviceId()}: enabled: ${result.enabled}`);
				await this.updateIfChanged('se_climate_react', result.enabled ? 'on' : 'off');
				if (this._lastClimateReact !== undefined && this._lastClimateReact !== result.enabled) {
					this.homey.app._climateReactChangedTrigger
						.trigger(this, {
							climate_react_enabled: result.enabled,
							climate_react: result.enabled ? 'enabled' : 'disabled',
						}, {})
						.then(() => this.log(`Climate React change triggered: ${this._sensibo.getDeviceId()}`, result.enabled))
						.catch((err) => this.log('Error triggering Climate React change:', err));
				}
				this._lastClimateReact = result.enabled;
			}
		}
	}

};
