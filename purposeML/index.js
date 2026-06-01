// index.js — barrel exports for purposeML.

export { extractFeatures } from './features.js'
export { classifyTrack } from './classifier.js'
export { classifyOneTrack, inputToPoints } from './service.js'
export { purposeMLApiPlugin } from './apiPlugin.js'
export { loadRegistry, classifyOwner } from './registry.js'
export {
  airportTraits,
  endpointAirports,
  inferredEndpoints,
  homeFieldFor,
} from './airports.js'
