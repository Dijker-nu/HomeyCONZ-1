'use strict'

const Homey = require('homey')
const Driver = require('../Driver')
const { http } = require('../../nbhttp')

class GroupDriver extends Driver {

	onInit() {
		super.onInit()

		this.initializeActions()
	
		this.log('GroupDriver has been initiated')
	}

	onPairListDevices(_, callback) {
		let capabilitiesArray = [
			['onoff'], 
			['onoff', 'dim'],
			['onoff', 'dim', 'light_temperature'],
			['onoff', 'dim', 'light_temperature', 'light_mode', 'light_saturation', 'light_hue']
		]

		let matchTable = {
			'On/Off light': 0,
			'Dimmable light': 1,
			'Color temperature light': 2,
			'Extended color light': 3,
			'Color light': 3,
			'Smart plug': 0, 
			'On/Off plug-in unit': 0,
			'Window covering device': 1
		}

		this.getGroupsList((groupError, groupDevices) => {
			if (groupError) {
				callback(groupError)
				return
			}
			this.getLightsList((lightError, lights) => {
				if (lightError) {
					callback(lightError)
					return
				}
				let devicesObjects = Object.entries(groupDevices).filter(entry => {
					const group = entry[1]
					return group.lights.length > 0
				}).map(entry => {
					const key = entry[0]
					const group = entry[1]
					let groupLights = Object.entries(lights).filter(entry => {
						const lightKey = entry[0]
						// const light = entry[1]
						return group.lights.includes(lightKey)
					}).map(light => {
						light = light[1]
						return matchTable[light.type]
					})

					return {
						name: group.name,
						data: {
							id: group.etag
						},
						settings: {
							id: key
						},
						capabilities: capabilitiesArray[Math.max.apply(Math, groupLights)]
					}
				})
				callback(null, devicesObjects)
			})
		})
	}

	getScenesList(groupId, callback) {
		http.get(`http://${Homey.app.host}:${Homey.app.port}/api/${Homey.app.apikey}/groups/${groupId}/scenes`, (error, response) => {
			callback(error, !!error ? null : JSON.parse(response))
		})
	}

	recallScene(groupId, sceneId, callback) {
		http.put(Homey.app.host, Homey.app.port, `/api/${Homey.app.apikey}/groups/${groupId}/scenes/${sceneId}/recall`, {}, (error, data) => {
			callback(error, !!error ? null : JSON.parse(data))
		})
	}

	setGroupState(groupId, state, callback) {
		http.put(Homey.app.host, Homey.app.port, `/api/${Homey.app.apikey}/groups/${groupId}/action`, state, (error, response) => {
			callback(error)
		})
	}

	initializeActions() {
		let recalSceneAction = new Homey.FlowCardAction('recall_scene');
		recalSceneAction
			.register()
			.registerRunListener(async (args, state) => {
				return new Promise((resolve) => {
					this.recallScene(args.device.id, args.scene.id, (error, result) => {
						if (error) {
							return this.error(error);
						}
						resolve(true);
					})
				});
			})
			.getArgument('scene')
			.registerAutocompleteListener((query, args) => {
				return new Promise((resolve) => {
					this.getScenesList(args.device.id, (error, scenes) => {
						if (error) {
							return this.error(error);
						}
						let result = [];
						Object.entries(scenes).forEach(entry => {
							const key = entry[0];
							const scene = entry[1];
							result.push({ name: scene.name, id: key });
						});
						resolve(result);
					})
				});
			});

		let flashGroupShortAction = new Homey.FlowCardAction('flash_short');
		flashGroupShortAction
			.register()
			.registerRunListener(async (args, state) => {
				const groupState = { alert: 'select' };
				return new Promise((resolve) => {
					this.setGroupState(args.device.id, groupState, (error) => {
						if (error) {
							return this.error(error);
						}
						resolve(true);
					})
				});
			});

		let flashGroupLongAction = new Homey.FlowCardAction('flash_long');
		flashGroupLongAction
			.register()
			.registerRunListener(async (args, state) => {
				const groupState = { alert: 'lselect' };
				return new Promise((resolve) => {
					this.setGroupState(args.device.id, groupState, (error) => {
						if (error) {
							return this.error(error);
						}
						resolve(true);
					})
				});
			});

		let setRelativeBrightnessAction = new Homey.FlowCardAction('relative_brightness');
		setRelativeBrightnessAction
			.register()
			.registerRunListener(async (args, state) => {
				const groupState = { bri_inc: args.relative_brightness * 254, transitiontime: args.transitiontime };
				return new Promise((resolve) => {
					this.setGroupState(args.device.id, groupState, (error) => {
						if (error) {
							return this.error(error);
						}
						resolve(true);
					})
				});
			});

		let setRelativeColorTemperatureAction = new Homey.FlowCardAction('relative_ct');
		setRelativeColorTemperatureAction
			.register()
			.registerRunListener(async (args, state) => {
				const groupState = { ct_inc: args.relative_ct * 254, transitiontime: args.transitiontime };
				return new Promise((resolve) => {
					this.setGroupState(args.device.id, groupState, (error) => {
						if (error) {
							return this.error(error);
						}
						resolve(true);
					})
				});
			});

		/*let setRelativeHueAction = new Homey.FlowCardAction('relative_hue');
		setRelativeHueAction
			.register()
			.registerRunListener(async (args, state) => {
				const groupState = { hue_inc: Math.round(args.relative_hue * 65534), transitiontime: args.transitiontime };
				return new Promise((resolve) => {
					this.setGroupState(groupState, (error) => {
						if (error) {
							return this.error(error);
						}
						resolve(true);
					})
				});
			});

		let setRelativeSaturationAction = new Homey.FlowCardAction('relative_saturation');
		setRelativeSaturationAction
			.register()
			.registerRunListener(async (args, state) => {
				const groupState = { sat_inc: Math.round(args.relative_saturation * 65534), transitiontime: args.transitiontime };
				return new Promise((resolve) => {
					this.setGroupState(groupState, (error) => {
						if (error) {
							return this.error(error);
						}
						resolve(true);
					})
				});
			});*/
	}
}

module.exports = GroupDriver
