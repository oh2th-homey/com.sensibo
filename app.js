'use strict';

const Homey = require('homey');
const Sensibo = require('./lib/sensibo');
const { randomDelay } = require('./lib/util');

class SensiboApp extends Homey.App {
	async onInit() {
		this.myAppIdVersion = `${this.homey.manifest.id}/${this.homey.manifest.version}`;
		this.log(`${this.myAppIdVersion} - onInit - starting...`);
		await this._initFlows();
		await this.createSensiboApi();
		await this.scheduleCheckData(15);
		this.log(`${this.myAppIdVersion} - onInit - started.`);
	}

	async onUninit() {
		this._deleted = true;
		this.clearCheckData();
	}

	async _initFlows() {
		this._turnedOnTrigger = this.homey.flow.getDeviceTriggerCard('se_onoff_true');
		this._turnedOffTrigger = this.homey.flow.getDeviceTriggerCard('se_onoff_false');
		this._offlineTrigger = this.homey.flow.getDeviceTriggerCard('se_offline');
		this._acStateChangedTrigger = this.homey.flow.getDeviceTriggerCard('se_ac_state_changed');
		this._climateReactChangedTrigger = this.homey.flow.getDeviceTriggerCard('se_climate_react_changed');
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

		this.homey.flow.getActionCard('sensibo_pureboost').registerRunListener((args, state) => args.device.onActionPureBoost(args.enabled));

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
			logger: this.log
		});
	}

	clearCheckData() {
		if (this.curTimeout) {
			this.homey.clearTimeout(this.curTimeout);
			this.curTimeout = undefined;
		}
	}

	async scheduleCheckData(interval = 60) {
		if (this._deleted) {
			return;
		}
		this.clearCheckData();
		// this.log(`New polling in ${interval} seconds`);
		this.curTimeout = this.homey.setTimeout(this.checkData.bind(this), interval * 1000);
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
			for (const apikey of apiKeys) {
				await randomDelay(2, 10);
				try {
					const data = await this._sensibo.getAllDeviceInfo(apikey);
					await this.onDevicesDataReceived(data, devices);
				} catch (err) {
					this.log('checkData api', err);
				}
			}
		} catch (err) {
			this.log('checkData', err);
		} finally {
			this.scheduleCheckData(pollingInterval);
		}
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

		this.log('Got Sensibo devices:', apiKeys, Array.from(devices.keys()), pInterval);
		return { apiKeys, devices, pInterval };
	}

	async onDevicesDataReceived(data, devices) {
		for (const resultItem of data.data.result) {
			await this.onDeviceInfoReceived(resultItem, devices);
			if (resultItem.motionSensors) {
				for (const msResultItem of resultItem.motionSensors) {
					await this.onDeviceInfoReceived(msResultItem, devices);
				}
			}
		}
	}

	async onDeviceInfoReceived(resultItem, devices) {
		if (resultItem.id) {
			const device = devices.get(resultItem.id);
			if (device && device.onDeviceInfoReceived) {
				// this.log(`Received data for device: ${device.getData().id}: `, resultItem);
				await device.onDeviceInfoReceived(resultItem);
			}
		}
	}
}

module.exports = SensiboApp;
