// Where the service is.
//
// One address, because there is one service. It measures heights from LiDAR,
// finds the overhead lines, builds the rough model, and holds the two synced
// lists -- see server/README.md. Those arrived at different times and each
// grew its own copy of this rule and its own localStorage key, which meant
// hosting the thing was two edits in two files that had to agree.
//
// Off unless the page is itself local, so the deployed app does not spend a
// round trip on a service that is only running on someone's laptop. Empty is a
// working configuration, not a broken one: heights stay marked as estimates and
// the lists stay on the device.
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(globalThis.location?.hostname ?? '');

// Put the public address here the day something hosts it. That is the whole of
// turning on measured heights and sync between two devices.
const DEFAULT_URL = LOCAL ? 'http://localhost:8130' : '';

// For pointing one browser somewhere else without touching the source.
export const OVERRIDE = 'dji.serviceUrl';

export function serviceUrl() {
  try {
    return (globalThis.localStorage?.getItem(OVERRIDE) ?? DEFAULT_URL).replace(/\/$/, '');
  } catch {
    // A browser with storage blocked still gets the default.
    return DEFAULT_URL;
  }
}
