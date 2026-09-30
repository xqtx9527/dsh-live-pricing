/**
 * Host half of dsh-live-pricing.
 *
 * The whole feature is browser-side: the Client half (client.js) renders the
 * price/time-band/session-cost bar and reads the durable `tokenUsage` and
 * `modelSelection` session projections that the shipped composition already
 * serves. Nothing needs to run in the Host process, so this half registers no
 * tools, listeners, or services — it exists so the package can declare a
 * `dsh.bundle.patch` row and a `dsh.client` browser half.
 *
 * @param {object} _ctx - the plugin's Cordis context (unused).
 */
export function apply(_ctx) {}
