// Where the hub can be reached from a phone: only over HTTPS (Tailscale Serve, or an HTTPS address
// you configure) plus loopback on this computer. The hub never listens on a LAN or tailnet IP, so
// there is no plain-HTTP address to pair with.

export interface Endpoint {
	label: string;
	url: string;
}

/** The loopback endpoint's label: this computer only, never put in a phone's QR code. */
export const LOOPBACK_LABEL = "this computer";

// Tailscale Serve lives in plain JavaScript (bin/tailscale.mjs) so `pi-mobile enrol` on a fresh box
// finds the address exactly as the hub does.
export { type CliResult, ensureServe, portTaken, type ServeResult, serveUrl, type TailscaleCli, tailscaleCli } from "../bin/tailscale.mjs";
