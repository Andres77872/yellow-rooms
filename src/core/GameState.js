export const Phase = {
  TITLE: 'TITLE',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  DEAD: 'DEAD',
  TRANSITION: 'TRANSITION',
}

// Plain runtime state shared between the controller, HUD, audio and engine.
export class GameState {
  constructor() {
    this.phase = Phase.TITLE
    this.level = 1
    this.seedText = ''
    this.mapFamily = 'office'
    this.seed = 0
    this.stamina = 1
    this.battery = 1
    this.sanity = 1
    this.exposure = 0 // seconds the flashlight has been held on the entity
    this.stareCharge = 0 // exposure as a 0..1 fraction of the current limit (HUD)
    this.flashlightOn = false
    this.deadAmount = 0
    this.deathReason = ''
  }

  resetLevel() {
    this.stamina = 1
    this.battery = 1
    this.sanity = 1
    this.exposure = 0
    this.stareCharge = 0
    this.flashlightOn = false
    this.deadAmount = 0
    this.deathReason = ''
  }
}
