'use strict'

const Light = require('../Light')
const { FlowCardTriggerDevice, Homey } = require('homey')

class GenericPlug extends Light {

	onInit() {
		super.onInit()

		this.setTriggers()

		this.log(this.getName(), 'has been initiated')
	}

	setTriggers() {
		this.triggerSwitched = new FlowCardTriggerDevice('switched').register()
	}

	setCapabilityValue(name, value) {
		if (name === 'onoff' && value != this.getCapabilityValue(name)) {
			this.triggerSwitched.trigger(this)
		}
		super.setCapabilityValue(name, value)
	}

	fireEvent(event, state) {
		this.log('generic-plug-unhandled-fire-event', event, state, this.getSetting('modelid'), this.getSetting('manufacturername'))
	}

}

module.exports = GenericPlug