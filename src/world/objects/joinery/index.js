// Architectural joinery builders — pure functions turning doorway / window
// metadata into unit-box instance descriptors, so the design language lives
// in ONE place and is testable headless (mesh.js only batches what it gets
// back). Doors (casing + leaves) in doors.js, gallery windows in windows.js,
// the shared emit helper in frame.js.
export { pushDoorFrame, pushDoorLeaves } from './doors.js'
export { pushWindowTrim } from './windows.js'
