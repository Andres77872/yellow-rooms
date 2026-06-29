import { Engine } from './core/Engine.js'

const app = document.getElementById('app')
const engine = new Engine(app)
engine.start()

// expose for debugging in the console
window.__game = engine
