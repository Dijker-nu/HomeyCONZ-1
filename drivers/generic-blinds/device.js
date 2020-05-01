'use strict'

const Light = require('../Light')

class GenericBlinds extends Light {
	
	onInit() {
		super.onInit()
		
		this.log(this.getName() + 'has been initiated')
	}
	
	setCapabilityValue(name, value) {
		if (name === 'onoff') {
			super.setCapabilityValue(name, !value)
		} else if (name === 'dim') {
			super.setCapabilityValue(name, 1 - value)
		}
	}
}

module.exports = GenericBlinds