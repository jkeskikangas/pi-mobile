export interface CliResult {
	/** Exit code; null when it is still running (returned early on `until`) or timed out. */
	code: number | null;
	out: string;
	/** Settles with the exit code once the process ends. */
	exited: Promise<number | null>;
}
export type TailscaleCli = (args: string[], opts?: { timeoutMs?: number; until?: RegExp; keepMs?: number }) => Promise<CliResult | undefined>;

export interface ServeResult {
	/** HTTPS address that reaches the hub. */
	url?: string;
	/** The tailnet must enable Serve/HTTPS first: one click at this link. */
	enable?: string;
	/** While waiting on `enable`: settles with the address once enabled (undefined if it never is). */
	pending?: Promise<string | undefined>;
}

export const tailscaleCli: TailscaleCli;
export function serveUrl(status: any, port: number): string | undefined;
export function portTaken(ip: string, port: number, timeoutMs?: number): Promise<boolean>;
export function ensureServe(port: number, cli?: TailscaleCli, taken?: (ip: string, port: number) => Promise<boolean>): Promise<ServeResult>;
export function tailnetName(cli?: TailscaleCli): Promise<string | undefined>;
