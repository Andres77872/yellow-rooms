import { TracerHost } from './tracerHost.js'

// Worker entry of the experimental realtime path tracer
// (PathTraceRealtime.js creates it lazily; tracerHost.js does the work).
const host = new TracerHost((message, transfer = []) => self.postMessage(message, transfer))
self.onmessage = (event) => host.handle(event.data)
