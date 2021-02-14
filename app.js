'use strict'

const Homey = require('homey');
const { http, https } = require('./nbhttp');
const WebSocketClient = require('ws');
const { util } = require('./util');
const fs = require('fs');

class deCONZ extends Homey.App {

	onInit() {

		// holds all devices that we have, added when a device gets initialized (see Sensor.registerInApp for example).
		this.devices = {
			lights: {},
			sensors: {},
			groups: {}
		}

		this.initializeTriggers()
		this.initializeConditions()
		this.initializeActions()

		this.usageId = Homey.ManagerSettings.get('usageId')
		if (!this.usageId) {
			this.usageId = util.generateGuid()
			Homey.ManagerSettings.set('usageId', this.usageId)
		}

		this.host = Homey.ManagerSettings.get('host')
		this.port = Homey.ManagerSettings.get('port')
		this.apikey = Homey.ManagerSettings.get('apikey')
		this.wsPort = Homey.ManagerSettings.get('wsport')
		this.sendUsageData = Homey.ManagerSettings.get('sendUsageData')
		if (this.sendUsageData !== false && this.sendUsageData !== true) {
			this.sendUsageData = true
		}
		this.autoRepairConnection = Homey.ManagerSettings.get('autoRepairConnection')
		if (this.autoRepairConnection !== false && this.autoRepairConnection !== true) {
			this.autoRepairConnection = true
		}

		Homey.ManagerSettings.on('set', this.onSettingsChanged.bind(this))

		this.startIntervalStateUpdate()
		this.startSendUsageDataUpdate()

		if (!this.host || !this.port || !this.apikey || !this.wsPort) {
			return this.log('Go to the app settings page and fill all the fields')
		}

		this.startWebSocketConnection()

		this.log('Listing local files...');
		fs.readdir(util.appDataFolder, (err, fileNames) => {
			if (fileNames) {
				fileNames.forEach(fileName => {
					this.log(fileName + '(' + util.getFileSizeInBytes(util.appDataFolder + fileName) + ' bytes)')
				})
			}
		})
	}

	startWebSocketConnection() {
		if (this.websocket) {
			this.websocket.terminate()
		}
		this.webSocketConnectTo(this.wsPort)
	}

	startIntervalStateUpdate() {
		if (this.pollIntervall) {
			clearInterval(this.pollIntervall)
		}
		let interval = Homey.ManagerSettings.get('pollingIntervall')
		if (!interval) {
			interval = 15
		}

		if (interval <= 0) {
			this.log('disable poll interval')
			return
		}

		this.log('setting up poll interval in minutes', interval)

		// Update all devices regularly. This might be needed for two cases
		// - state/config values that do not update very often, such as the battery for certain devices: in that case we would need to wait until something changes s.t we receive
		//   it trough the websocket update
		// - some config values are not pushed via websockets such as the sensitivity of certain devices
		// IMPORTANT: decreasing this might get cpu warnings and lead to a disabled app!
		this.pollIntervall = setInterval(() => {
			this.log("Polling current states");
			this.setInitialStates()
		}, interval * 60 * 1000)
	}

	startSendUsageDataUpdate() {
		setTimeout(() => {
			this.sendUsageDataFullState()
		}, 15 * 1000)

		setInterval(() => {
			this.sendUsageDataFullState()
		}, 1000 * 60 * 60 * 24 * 3)
	}

	onSettingsChanged(modifiedKey) {

		this.log('settings changed', modifiedKey)

		this.host = Homey.ManagerSettings.get('host')
		this.port = Homey.ManagerSettings.get('port')
		this.apikey = Homey.ManagerSettings.get('apikey')
		this.wsPort = Homey.ManagerSettings.get('wsport')
		this.sendUsageData = Homey.ManagerSettings.get('sendUsageData')
		if (this.sendUsageData !== false && this.sendUsageData !== true) {
			this.sendUsageData = true
		}
		this.autoRepairConnection = Homey.ManagerSettings.get('autoRepairConnection')
		if (this.autoRepairConnection !== false && this.autoRepairConnection !== true) {
			this.autoRepairConnection = true
		}

		if (modifiedKey == 'sendUsageData') {
			this.uploadUsageData('sendUsageData', { sendUsageData: this.sendUsageData })
		}

		if (modifiedKey == 'pollingIntervall') {
			this.startIntervalStateUpdate()
		}

		if (modifiedKey == 'host' || modifiedKey == 'port' || modifiedKey == 'apikey' || modifiedKey == 'wsPort') {
			if (!!this.host && !!this.port && !!this.apikey && !!this.wsPort) {
				this.startWebSocketConnection()
			}
		} else {
			this.log('update ws connection not necessary')
		}
	}

	setWSKeepAlive() {
		if (this.keepAliveTimeout) {
			clearTimeout(this.keepAliveTimeout)
		}
		this.websocket.on('ping', () => {
			if (this.keepAliveTimeout) {
				clearTimeout(this.keepAliveTimeout)
			}
			this.keepAliveTimeout = setTimeout(() => {
				this.error('Connection lost')
				this.startWebSocketConnection()
			}, 3.1 * 60 * 1000)
		})
		// ping every 60 seconds
		setInterval(() => {
			try {
				this.websocket.ping()
			} catch (error) {
				this.error('Can\'t ping websocket')
				this.error(error)
			}
		}, 60 * 1000)
	}

	handleMessage(message) {
		let data = JSON.parse(message)
		let device = this.getDevice(data.r, data.id)

		if (device) {
			if (data.state) {
				this.updateState(device, data.state)
			} else if (data.action) {
				// applies to groups only
				this.updateState(device, data.action)
			} else if (data.config) {
				this.updateConfig(device, data.config)
			}
		} else if (data.attr && data.attr.modelid !== 'ConBee') {
			this.log('Update for unregistered device', data)
		}
	}

	webSocketConnectTo() {
		this.log('Websocket connect...')
		this.wsConnected = false
		this.websocket = new WebSocketClient(`ws://${this.host}:${this.wsPort}`)
		this.websocket.on('open', () => {
			this.wsConnected = true
			this.log('Websocket is up')
			this.setWSKeepAlive()
		})
		this.websocket.on('message', message => {
			this.handleMessage(message)
		})
		this.websocket.on('error', error => {
			this.error('Websocket error', error)
		})
		this.websocket.on('close', (reasonCode, _) => {
			if (this.wsConnected === true && this.autoRepairConnection === true) {
				this.attemptAutoRepair()
			}
			this.setAllUnavailable()
			this.error(`Closed, error #${reasonCode}, autoRepair ${this.autoRepairConnection}, isFirstFailure ${this.wsConnected === true}`)
			this.log('Reconnection in 5 seconds...')
			this.wsConnected = false
			setTimeout(
				this.webSocketConnectTo.bind(this),
				5 * 1000
			)
		})
	}

	getLightState(device, callback) {
		http.get(`http://${this.host}:${this.port}/api/${this.apikey}/lights/${device.id}`, (error, response) => {
			callback(error, !!error ? null : JSON.parse(response))
		})
	}

	getSensorState(device, callback) {
		http.get(`http://${this.host}:${this.port}/api/${this.apikey}/sensors/${device.id}`, (error, response) => {
			callback(error, !!error ? null : JSON.parse(response))
		})
	}

	getLightsList(callback) {
		http.get(`http://${this.host}:${this.port}/api/${this.apikey}/lights`, (error, response) => {
			try {
				callback(error, !!error ? null : JSON.parse(response))
			} catch (e) {
				callback('invalid response', null)
			}
		})
	}

	getSensorsList(callback) {
		http.get(`http://${this.host}:${this.port}/api/${this.apikey}/sensors`, (error, response) => {
			try {
				callback(error, !!error ? null : JSON.parse(response))
			} catch (e) {
				callback('invalid response', null)
			}
		})
	}

	getGroupsList(callback) {
		http.get(`http://${Homey.app.host}:${Homey.app.port}/api/${Homey.app.apikey}/groups`, (error, response) => {
			try {
				callback(error, !!error ? null : JSON.parse(response))
			} catch (e) {
				callback('invalid response', null)
			}
		})
	}

	getFullState(callback) {
		const wsState = this.websocket && this.websocket.readyState === 1
		http.get(`http://${this.host}:${this.port}/api/${this.apikey}`, (error, response) => {
			if (!!error) {
				callback(error, null)
			} else {

				try {


					let state = JSON.parse(response)

					let anonymizedState = {
						wsConnected: wsState,
						usageId: this.usageId,
						deCONZ: {
							apiversion: state.config.apiversion,
							datastoreversion: state.config.datastoreversion,
							dhcp: state.config.dhcp,
							fwversion: state.config.fwversion,
							swversion: state.config.swversion,
							websocketnotifyall: state.config.websocketnotifyall,
							name: state.config.name,
							mac: state.config.mac,
							zigbeechannel: state.config.zigbeechannel,
							panid: state.config.panid,
							devicename: state.config.devicename
						},
						groups: [],
						lights: [],
						sensors: []
					}

					Object.entries(state.groups).forEach(entry => {
						const key = entry[0]
						const group = entry[1]
						group.name = undefined
						group.etag = undefined
						anonymizedState.groups.push(group)
					})

					Object.entries(state.lights).forEach(entry => {
						const key = entry[0]
						const light = entry[1]
						light.name = undefined
						light.etag = undefined
						anonymizedState.lights.push(light)
					})

					Object.entries(state.sensors).forEach(entry => {
						const key = entry[0]
						const sensor = entry[1]
						sensor.name = undefined
						sensor.etag = undefined
						anonymizedState.sensors.push(sensor)
					})

					callback(null, anonymizedState)

				} catch (error) {
					this.log(error)
					callback(error, null)
				}
			}
		})
	}

	getConfig(callback) {
		http.get(`http://${this.host}:${this.port}/api/${this.apikey}/config`, (error, response) => {
			if (!!error) {
				callback(error, null)
			} else {
				callback(null, JSON.parse(response))
			}
		})
	}

	createBackup(callback) {
		http.post(Homey.app.host, Homey.app.port, `/api/${Homey.app.apikey}/config/export`, {}, (error, response) => {
			if (!!error) {
				callback(error, null)
			} else {
				setTimeout(() => {
					this.downloadBackup(callback)
				}, 3000)
			}
		})
	}

	downloadBackup(callback) {
		http.downloadToFile(`http://${this.host}/deCONZ.tar.gz`, util.appDataFolder + 'deCONZ.tar.gz', (error, success) => {
			if (!!error) {
				callback(error, null)
			} else {
				callback(null, success)
			}
		})
	}

	getBackups(callback) {
		try {
			fs.readdir(util.appDataFolder, (error, fileNames) => {
				if (error || fileNames == undefined) {
					callback(error, null)
				}
				else {
					let backups = [];
					fileNames.forEach(fileName => {
						backups.push({
							name: fs.statSync(util.appDataFolder + fileName).ctime,
							size: util.getFileSizeInBytes(util.appDataFolder + fileName)
						})
					})
					callback(null, backups)
				}
			});
		} catch (e) {
			this.log('error while getting backups', e)
			callback(e, null)
		}
	}

	getBackup(callback) {
		try {
			fs.readdir(util.appDataFolder, (error, fileNames) => {
				if (error || fileNames == undefined || fileNames.length == 0) {
					callback(error, null)
				}
				else {
					fs.readFile(util.appDataFolder + fileNames[0], { encoding: 'base64' }, function (e, data) {
						if (e) {
							callback(e, null)
						}
						else {
							callback(null, { name: 'deCONZ.tar.gz', type: 'application/octet-stream', content: data })
						}
					})
				}
			});
		} catch (e) {
			this.log('error while getting backup', e)
			callback(e, null)
		}
	}

	test(host, port, apikey, callback) {
		const wsState = this.websocket && this.websocket.readyState === 1
		http.get(`http://${host}:${port}/config/${apikey}`, (error, response) => {
			if (!!error) {
				callback(error, null)
			} else {
				try {
					let state = JSON.parse(response)
					state.wsConnected = wsState
					callback(null, state)
				} catch (e) {
					callback('invalid response', null)
				}
			}
		})
	}

	getDeconzUpdates(callback) {
		this.getConfig((configError, config) => {
			if (!!configError) {
				callback(configError, null)
			} else {
				https.get(`https://api.github.com/repos/dresden-elektronik/deconz-rest-plugin/releases/latest`, (releaseError, release) => {
					if (!!releaseError) {
						callback(releaseError, null)
					} else {

						let parsedRelease = JSON.parse(release)
						let nextRaw = parsedRelease.tag_name.replace("_stable", "").replace("_", ".").replace("_", ".").replace("V", "").replace("v", "")

						let nextMajor = parseInt(nextRaw.split('.')[0], 0)
						let nextMinor = parseInt(nextRaw.split('.')[1], 0)
						let nextBuild = parseInt(nextRaw.split('.')[2], 0)

						let currentMajor = parseInt(config.swversion.split('.')[0], 0)
						let currentMinor = parseInt(config.swversion.split('.')[1], 0)
						let currentBuild = parseInt(config.swversion.split('.')[2], 0)

						let result = {
							updateAvailable: (currentMajor * 100 + currentMinor * 10 + currentBuild) < (nextMajor * 100 + nextMinor * 10 + nextBuild),
							current: currentMajor + '.' + currentMinor + '.' + currentBuild,
							next: nextMajor + '.' + nextMinor + '.' + nextBuild + ' (' + parsedRelease.name + ')',
							// description: parsedRelease.body,
							url: parsedRelease.html_url
						}

						this.log(result)

						callback(null, result)
					}
				})
			}
		})
	}

	getDeconzDockerUpdates(callback) {
		this.getConfig((configError, config) => {
			if (!!configError) {
				callback(configError, null)
			} else {
				https.get(`https://raw.githubusercontent.com/marthoc/docker-deconz/master/version.json`, (releaseError, release) => {
					if (!!releaseError) {
						callback(releaseError, null)
					} else {

						let parsedRelease = JSON.parse(release)
						let nextRaw = parsedRelease.version

						let nextMajor = parseInt(nextRaw.split('.')[0], 0)
						let nextMinor = parseInt(nextRaw.split('.')[1], 0)
						let nextBuild = parseInt(nextRaw.split('.')[2], 0)

						let currentMajor = parseInt(config.swversion.split('.')[0], 0)
						let currentMinor = parseInt(config.swversion.split('.')[1], 0)
						let currentBuild = parseInt(config.swversion.split('.')[2], 0)

						let result = {
							updateAvailable: (currentMajor * 100 + currentMinor * 10 + currentBuild) < (nextMajor * 100 + nextMinor * 10 + nextBuild),
							current: currentMajor + '.' + currentMinor + '.' + currentBuild,
							next: nextMajor + '.' + nextMinor + '.' + nextBuild + ' (' + parsedRelease.channel + ')'
						}

						this.log(result)

						callback(null, result)
					}
				})
			}
		})
	}

	getDiscoveryData(callback) {
		http.get(`http://phoscon.de/discover`, (error, response) => {
			if (error) {
				callback(error, null)
			} else if (response.startsWith('[')) {
				callback(null, JSON.parse(response)[0])
			} else {
				Homey.app.sendUsageData('invalid-discovery', response)
				callback('invalid response', null)
			}
		})
	}

	discover(callback) {
		this.log('[SETTINGS-API] start discovery')
		this.getDiscoveryData((error, discoveryResponse) => {
			if (error || discoveryResponse == null) {
				this.log('[SETTINGS-API] discovery failed', error)
				callback('Unable to find a deCONZ gateway', null)
			} else {
				this.log('[SETTINGS-API] discovery successfull, starting registration')
				http.post(discoveryResponse.internalipaddress, discoveryResponse.internalport, '/api', { "devicetype": "homeyCONZ" }, (error, registerResponse, statusCode) => {
					if (error) {
						this.log('[SETTINGS-API] registration failed', error)
						callback('Found a unreachable gateway', null)
					} else if (statusCode === 403) {
						this.log('[SETTINGS-API] registration incomplete, authorization needed')
						callback(null, { host: discoveryResponse.internalipaddress, port: discoveryResponse.internalport, message: 'Successfuly discovered the deCONZ gateway! Please open up Phoscon, go to settings→gateway→advanced and click on authenticate in the phoscon app. Finalize the setup by clicking on "connect" bellow.' })
					} else if (statusCode === 200) {
						this.log('[SETTINGS-API] registration successful')
						this.completeAuthentication(discoveryResponse.internalipaddress, discoveryResponse.internalport, JSON.parse(registerResponse)[0].success.username, callback)
					} else if (statusCode === 404) {
						this.log('[SETTINGS-API] gateway discovered but not accessible')
						callback('The gateway was discovered but failed to connect. Note to docker users: if you did not set up your docker container correctly (with the --net=host parameter) you have disabled autodiscovery actively. You can continue but you must enter all configurations bellow manually!', null)
					} else {
						this.log('[SETTINGS-API] registration failed with unknown status code', statusCode)
						callback('Unknown error', null)
					}
				})
			}
		})
	}

	authenticate(host, port, callback) {
		this.log('[SETTINGS-API] start authenticate', host, port)

		http.post(host, port, '/api', { "devicetype": "homeyCONZ" }, (error, response, statusCode) => {
			if (statusCode === 403) {
				this.log('[SETTINGS-API] authenticate failed, authorization needed')
				callback(null, { host: host, port: port, message: 'Please open up Phoscon, go to settings→gateway→advanced and click on authenticate in the phoscon app. Finalize the setup by clicking on "connect" bellow.' })
			} else if (statusCode === 200) {
				this.log('[SETTINGS-API] authenticate successful')
				this.completeAuthentication(host, port, JSON.parse(response)[0].success.username, callback)
			} else {
				this.log('[SETTINGS-API] authenticate failed', statusCode)
				callback('Unknown error', null)
			}
		})
	}

	completeAuthentication(host, port, apikey, callback) {
		this.log('[SETTINGS-API] fetch config')
		http.get(`http://${host}:${port}/api/${apikey}/config`, (error, result) => {
			if (error) {
				this.log('[SETTINGS-API] error getting config', error)
				callback('Error getting WS port', null)
			} else {

				Homey.ManagerSettings.set('host', host, (err, settings) => {
					if (err) callback(err, null)
				})
				Homey.ManagerSettings.set('port', port, (err, settings) => {
					if (err) callback(err, null)
				})
				Homey.ManagerSettings.set('wsport', JSON.parse(result).websocketport, (err, settings) => {
					if (err) callback(err, null)
				})
				Homey.ManagerSettings.set('apikey', apikey, (err, settings) => {
					if (err) callback(err, null)
				})

				this.log('[SETTINGS-API] successfully persisted config')
				callback(null, 'Successfuly discovered and authenticated the deCONZ gateway!')
			}
		})
	}

	setInitialStates() {

		if (!this.host || !this.port || !this.apikey) {
			return this.log('Go to the app settings page and fill all the fields')
		}

		this.getLightsList((error, lights) => {
			if (error) {
				if (error.code == 'EHOSTUNREACH' && this.autoRepairConnection) {
					this.attemptAutoRepair()
				}
				return this.error('error getting lights', error)
			}
			Object.entries(lights).forEach(entry => {
				const key = entry[0]
				const light = entry[1]
				const device = this.getDevice('lights', key)
				if (device && light.state) {
					this.updateState(device, light.state)
				}
				if (device) {
					this.updateDeviceInfo(device, light)
				}
			})
		})

		this.getSensorsList((error, sensors) => {
			if (error) {
				return this.error('error getting sensor', error)
			}
			Object.entries(sensors).forEach(entry => {
				const key = entry[0]
				const sensor = entry[1]
				const device = this.getDevice('sensors', key)
				if (device) {
					if (sensor.state) {
						this.updateState(device, sensor.state, true)
					}
					if (sensor.config) {
						this.updateConfig(device, sensor.config, true)
					}
					this.updateDeviceInfo(device, sensor)
				}
			})
		})

		this.getGroupsList((error, groups) => {
			if (error) {
				return this.error('error getting groups', error)
			}

			Object.entries(groups).forEach(entry => {
				const key = entry[0]
				const group = entry[1]
				const device = this.getDevice('groups', key)
				if (device) {
					if (group.action) {
						this.updateState(device, group.action, true)
						device.setAvailable()
					}
				}
			})
		})

	}

	// websocket processing

	setAllUnavailable() {
		Object.values(this.devices.lights).forEach(device => {
			device.setUnavailable('Websocket is down')
		})
		Object.values(this.devices.sensors).forEach(device => {
			device.setUnavailable('Websocket is down')
		})
		Object.values(this.devices.groups).forEach(device => {
			device.setUnavailable('Websocket is down')
		})
	}

	getDevice(type, id) {
		if (this.devices[type] && this.devices[type].hasOwnProperty(id)) {
			return this.devices[type][id]
		}
		return null
	}

	updateState(device, state, initial = false) {
		let deviceCapabilities = device.getCapabilities()
		let deviceSupports = (capabilities) => {
			if (typeof (capabilities) == 'string') capabilities = [capabilities]
			return !capabilities.map(capability => {
				return deviceCapabilities.includes(capability)
			}).includes(false)
		}

		// this.log('state update for', device.getSetting('id'), device.getName()/*, state*/)

		if (state.hasOwnProperty('buttonevent') && !initial) {
			device.fireEvent(state.buttonevent, state)
		}

		if (state.hasOwnProperty('buttonevent') && state.hasOwnProperty('gesture')) {
			device.fireEvent(state.buttonevent, initial, state.gesture, state)
		}

		if (state.hasOwnProperty('open')) {
			if (deviceSupports('alarm_contact')) {
				const invert = device.getSetting('invert_alarm') == null ? false : device.getSetting('invert_alarm')
				if (invert === true) {
					device.setCapabilityValue('alarm_contact', !state.open)
				} else {
					device.setCapabilityValue('alarm_contact', state.open)
				}
			}
		}

		if (state.hasOwnProperty('presence')) {
			if (deviceSupports('alarm_motion')) {
				device.setCapabilityValue('alarm_motion', state.presence)
			}
		}

		if (state.hasOwnProperty('vibration')) {
			if (deviceSupports('vibration_alarm')) {
				device.setCapabilityValue('vibration_alarm', state.vibration)
			}
		}

		if (state.hasOwnProperty('vibrationstrength')) {
			if (deviceSupports('vibration_strength')) {
				device.setCapabilityValue('vibration_strength', state.vibrationstrength)
			}
		}

		if (state.hasOwnProperty('tiltangle')) {
			if (deviceSupports('tilt_angle')) {
				device.setCapabilityValue('tilt_angle', state.tiltangle)
			}
		}

		if (state.hasOwnProperty('on')) {
			if (deviceSupports('onoff')) {
				device.setCapabilityValue('onoff', state.on)
			}
		}

		// siren
		if (state.hasOwnProperty('alert')) {
			if (deviceSupports('onoff')) {
				device.handleAlertState(state)
			}
		}

		if (state.hasOwnProperty('any_on')) {
			if (deviceSupports('onoff')) {
				device.setCapabilityValue('onoff', state.any_on)
			}
		}

		if (state.hasOwnProperty('dark')) {
			if (deviceSupports('dark')) {
				device.setCapabilityValue('dark', state.dark)
			}
		}

		if (state.hasOwnProperty('lux')) {
			if (deviceSupports('measure_luminance')) {
				device.setCapabilityValue('measure_luminance', state.lux)
			}
		}

		if (state.hasOwnProperty('bri')) {
			if (deviceSupports('dim')) {
				device.setCapabilityValue('dim', state.bri / 255)
			}
		}

		if (state.hasOwnProperty('reachable')) {
			let ignoreReachable = device.getSetting('ignore-reachable') === true;

			if (!ignoreReachable) {
				if (state.reachable === true && !device.getAvailable()) {
					this.deviceReachableTrigger.trigger({ device: device.getName() })
				} else if (state.reachable === false && device.getAvailable()) {
					this.deviceUnreachableTrigger.trigger({ device: device.getName() })
				}
			}

			(state.reachable || ignoreReachable) ? device.setAvailable() : device.setUnavailable('Unreachable')
		}

		if (state.hasOwnProperty('water')) {
			if (deviceSupports('alarm_water')) {
				const invert = device.getSetting('invert_alarm') == null ? false : device.getSetting('invert_alarm')
				if (invert === true) {
					device.setCapabilityValue('alarm_water', !state.water)
				} else {
					device.setCapabilityValue('alarm_water', state.water)
				}
			}
		}

		// todo: check, should be okay
		if (state.hasOwnProperty('colormode')) {
			if (deviceSupports('light_mode')) {
				device.setCapabilityValue('light_mode', (state.colormode == 'xy' || state.colormode == 'hs') ? 'color' : 'temperature')
			}
		}

		if (state.hasOwnProperty('fire')) {
			if (deviceSupports('alarm_smoke')) {
				device.setCapabilityValue('alarm_smoke', state.fire)
			}
		}

		if (state.hasOwnProperty('carbonmonoxide')) {
			if (deviceSupports('alarm_co')) {
				device.setCapabilityValue('alarm_co', state.carbonmonoxide)
			}
		}

		if (state.hasOwnProperty('temperature')) {
			if (deviceSupports('measure_temperature')) {
				const offset = device.getSetting('temperature_offset') == null ? 0 : device.getSetting('temperature_offset')
				device.setCapabilityValue('measure_temperature', (state.temperature / 100) + offset)
			}
		}

		if (state.hasOwnProperty('humidity')) {
			if (deviceSupports('measure_humidity')) {
				const offset = device.getSetting('humidity_offset') == null ? 0 : device.getSetting('humidity_offset')
				device.setCapabilityValue('measure_humidity', (state.humidity / 100) + offset)
			}
		}

		if (state.hasOwnProperty('pressure')) {
			if (deviceSupports('measure_pressure')) {
				const offset = device.getSetting('pressure_offset') == null ? 0 : device.getSetting('pressure_offset')
				device.setCapabilityValue('measure_pressure', state.pressure + offset)
			}
		}

		if (state.hasOwnProperty('power')) {
			if (deviceSupports('measure_power')) {
				device.setCapabilityValue('measure_power', state.power)
			}
		}

		if (state.hasOwnProperty('voltage')) {
			if (deviceSupports('measure_voltage')) {
				device.setCapabilityValue('measure_voltage', state.voltage)
			}
		}

		if (state.hasOwnProperty('current')) {
			if (deviceSupports('measure_current')) {
				device.setCapabilityValue('measure_current', state.current / 100)
			}
		}

		if (state.hasOwnProperty('consumption')) {
			if (deviceSupports('meter_power')) {
				device.setCapabilityValue('meter_power', state.consumption / 1000)
			}
		}

		if (state.hasOwnProperty('ct') && state.hasOwnProperty('colormode') && state.colormode === 'ct') {
			if (!deviceSupports(['light_mode', 'light_temperature']) || (state.ct > 500)) return
			device.setCapabilityValue('light_mode', 'temperature')
			device.setCapabilityValue('light_temperature', (state.ct - 153) / 347)
		}

		if (state.hasOwnProperty('hue') && state.hasOwnProperty('colormode') && state.colormode === 'hs') {
			if (!deviceSupports('light_hue')) return
			device.setCapabilityValue('light_hue', parseFloat((state.hue / 65535).toFixed(2)))
		}

		if (state.hasOwnProperty('sat') && state.hasOwnProperty('colormode') && state.colormode === 'hs') {
			if (!deviceSupports('light_saturation')) return
			device.setCapabilityValue('light_saturation', parseFloat((state.sat / 255).toFixed(2)))
		}

		if (state.hasOwnProperty('xy') && state.hasOwnProperty('colormode') && state.colormode === 'xy') {
			if (!deviceSupports('light_hue') || !deviceSupports('light_saturation')) return
			var hs = util.xyToHs(state.xy[0], state.xy[1], 255)
			device.setCapabilityValue('light_hue', parseFloat((hs.hue).toFixed(2)))
			device.setCapabilityValue('light_saturation', parseFloat((hs.sat).toFixed(2)))
		}

		if (state.hasOwnProperty('tampered')) {
			if (deviceSupports('alarm_tamper')) {
				device.setCapabilityValue('alarm_tamper', state.tampered)
			}
		}

		if (state.hasOwnProperty('airqualityppb')) {
			if (deviceSupports('measure_voc')) {
				device.setCapabilityValue('measure_voc')
			}
		}

		if (state.hasOwnProperty('lastupdated') && device.getSetting('lastUpdated') != null) {
			device.setSettings({ lastUpdated: state.lastupdated });
		}
	}

	updateConfig(device, config, initial = false) {

		// this.log('config update for', device.getSetting('id'), device.getName()/*, config*/)

		let deviceСapabilities = device.getCapabilities()

		if (config.hasOwnProperty('temperature') && deviceСapabilities.includes('measure_temperature')) {
			device.setCapabilityValue('measure_temperature', config.temperature / 100)
		}

		if (config.hasOwnProperty('battery') && deviceСapabilities.includes('measure_battery')) {
			device.setCapabilityValue('measure_battery', config.battery)
		}

		if (config.hasOwnProperty('sensitivity') && device.getSetting('sensitivity') != null) {
			device.setSettings({ sensitivity: config.sensitivity });
		}

		if (config.hasOwnProperty('ledindication') && device.getSetting('ledindication') != null) {
			device.setSettings({ ledindication: config.ledindication });
		}

		if (config.hasOwnProperty('pending') && device.getSetting('pending') != null) {
			device.setSettings({ pending: JSON.stringify(config.pending) });
		}

		if (config.hasOwnProperty('heatsetpoint') && deviceСapabilities.includes('target_temperature')) {
			device.setCapabilityValue('target_temperature', config.heatsetpoint / 100)
		}

		if (config.hasOwnProperty('reachable')) {
			(config.reachable || device.getSetting('ignore-reachable') === true) ? device.setAvailable() : device.setUnavailable('Unreachable')
		}
	}

	updateDeviceInfo(device, data) {

		// this.log('device info update for', device.getSetting('id'), device.getName()/*, data*/)

		let modelId = device.getSetting('modelid')
		if (data.hasOwnProperty('modelid') && modelId != null && modelId != data.modelid) {
			device.setSettings({ modelid: data.modelid });
		}

		let manufacturername = device.getSetting('manufacturername')
		if (data.hasOwnProperty('manufacturername') && manufacturername != null && manufacturername != data.manufacturername) {
			device.setSettings({ manufacturername: data.manufacturername });
		}

		let swversion = device.getSetting('swversion')
		if (data.hasOwnProperty('swversion') && swversion != null && swversion != data.swversion) {
			if (typeof data.swversion !== 'string') {
				device.setSettings({ swversion: JSON.stringify(data.swversion) });
			} else {
				device.setSettings({ swversion: data.swversion });
			}
		}

		if (device.getSetting('ids') != null && device.getSetting('id') != null) {
			if (typeof device.getSetting('ids') !== 'string') {
				device.setSettings({ ids: null });
			}
			device.setSettings({ ids: JSON.stringify(device.getSetting('id')) });
		}

		if (device.getSetting('sensorids') != null && device.getSetting('sensors') != null) {
			if (typeof device.getSetting('sensorids') !== 'string') {
				device.setSettings({ sensorids: null });
			}
			device.setSettings({ sensorids: JSON.stringify(device.getSetting('sensors')) });
		}

		if (data.hasOwnProperty('uniqueid') && device.getSetting('mac') != null) {
			device.setSettings({ mac: data.uniqueid.split('-')[0] });
		}

		let lastseen = device.getSetting('lastseen')
		if (data.hasOwnProperty('lastseen') && lastseen != null && lastseen != data.lastseen) {
			if (typeof data.lastseen !== 'string') {
				device.setSettings({ lastseen: JSON.stringify(data.lastseen) });
			} else {
				device.setSettings({ lastseen: data.lastseen });
			}
		}
	}

	get(url, callback) {
		let handler = (error, result) => {
			callback(error, !!error ? null : JSON.parse(result))
		}
		if (url.startsWith('https')) {
			https.get(url, handler)
		} else {
			http.get(url, handler)
		}
	}

	getWSport(callback) {
		this.get(`http://${this.host}:${this.port}/api/${this.apikey}/config`, (error, result) => {
			callback(error, !!error ? null : result.websocketport)
		})
	}

	initializeActions() {

		let simulateMessageAction = new Homey.FlowCardAction('debug_send_message');
		simulateMessageAction
			.register()
			.registerRunListener(async (args, state) => {
				return new Promise((resolve) => {
					try {
						this.log('simulate incoming message', args.message)
						this.handleMessage(args.message)
						resolve(true)
					} catch (error) {
						this.log('error while simulating a message', error)
						resolve(false)
					}
				});
			});

		let updateAllDevicesManuallyAction = new Homey.FlowCardAction('update_all_devices');
		updateAllDevicesManuallyAction
			.register()
			.registerRunListener(async (args, state) => {
				return new Promise((resolve) => {
					try {
						this.log('update all devices manually')
						this.setInitialStates()
						resolve(true)
					} catch (error) {
						this.log('error while updating all devices', error)
						resolve(false)
					}
				});
			});

		let updateIpAddressAction = new Homey.FlowCardAction('update_ip_address');
		updateIpAddressAction
			.register()
			.registerRunListener(async (args, state) => {
				return new Promise((resolve) => {
					try {
						this.attemptAutoRepair();
						resolve(true)
					} catch (error) {
						this.log('error while performing auto repair', error)
						resolve(false)
					}
				});
			});

		let createBackupAction = new Homey.FlowCardAction('create_backup');
		createBackupAction
			.register()
			.registerRunListener(async (args, state) => {
				return new Promise((resolve) => {
					try {
						this.createBackup((error, success) => {
							if (error) {
								resolve(false)
							} else {
								resolve(true)
							}
						})

					} catch (error) {
						this.log('error while creating backup', error)
						resolve(false)
					}
				});
			});

	}

	initializeTriggers() {
		this.deviceReachableTrigger = new Homey.FlowCardTrigger('device_on_reachable').register();
		this.deviceUnreachableTrigger = new Homey.FlowCardTrigger('device_on_unreachable').register();
	}

	initializeConditions() {
		let checkDeconzUpdatesCondition = new Homey.FlowCardCondition('check_deconz_updates');
		checkDeconzUpdatesCondition
			.register()
			.registerRunListener(async (args, state) => {
				return new Promise((resolve, reject) => {
					this.getDeconzDockerUpdates((error, success) => {
						this.log('check for deconz updates', !error && success.updateAvailable === true);
						resolve(!error && success.updateAvailable === true)
					})
				});
			});

		let checkDeconzDockerUpdatesCondition = new Homey.FlowCardCondition('check_deconz_docker_updates');
		checkDeconzDockerUpdatesCondition
			.register()
			.registerRunListener(async (args, state) => {
				return new Promise((resolve, reject) => {
					this.getDeconzDockerUpdates((error, success) => {
						this.log('check for docker updates', !error && success.updateAvailable === true);
						resolve(!error && success.updateAvailable === true)
					})
				});
			});
	}

	sendUsageDataFullState() {
		if (this.sendUsageData) {
			this.getFullState((err, result) => {
				if (err) {
					this.log('Error while fetching full state', err)
				} else {

					this.usageDataQueue = []

					result.groups.forEach(e => this.usageDataQueue.push({ type: 'fullstate-group', content: e }))
					result.lights.forEach(e => this.usageDataQueue.push({ type: 'fullstate-light', content: e }))
					this.usageDataQueue.push({ type: 'fullstate-deconz', content: result.deCONZ })
					result.sensors.forEach(e => this.usageDataQueue.push({ type: 'fullstate-sensor', content: e }))
					this.dequeueUsageData()
				}
			})
		}
	}

	dequeueUsageData() {
		if (this.usageDataQueue.length > 0) {
			let entry = this.usageDataQueue.pop()
			this.uploadUsageData(entry.type, entry.content)
			setTimeout(() => {
				this.dequeueUsageData()
			}, 1500)
		}
	}

	uploadUsageData(type, content) {
		if (this.sendUsageData) {
			this.log('upload usage data', type, this.usageId)
			let payload = { Type: type, Content: content, Identifier: this.usageId }
			https.post(Homey.env.USAGE_DATA_HOST, 443, Homey.env.USAGE_DATA_PATH, payload, (error, response, statusCode) => {
				if (error) {
					this.log('Error while sending usage data', error)
				} else {
					this.log('Sent usage data', type, response, statusCode)
					if (statusCode != 200) {
						this.log(JSON.stringify(payload))
					}
				}
			})
		}
	}

	attemptAutoRepair() {
		this.log('attempt auto repair...')
		this.getDiscoveryData((error, response) => {
			if (error) {
				this.log(error)
				return this.error(error)
			}
			else if (response != undefined && response != null && Object.keys(response).length > 0 && response.internalipaddress && this.host !== response.internalipaddress) {
				this.log('ip address has changed', this.host, response.internalipaddress)
				Homey.ManagerSettings.set('host', response.internalipaddress, (err, settings) => {
					if (err) this.error(err)
				})
				this.startWebSocketConnection()
				this.log('ip address updated successfully')
			} else {
				this.log('no deconz changed gateway found')
			}
		})
	}
}

module.exports = deCONZ