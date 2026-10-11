// One rule for every HTTPS address pi-mobile accepts (config publicUrl, /remote settings, `pi-mobile add`).
// Plain JavaScript and dependency-free: `bin/` runs via npx on a fresh box.

/**
 * The normalized address (origin plus path, no trailing slash) when `value` is a well-formed https:// URL
 * with a host, no user info, query or fragment; otherwise undefined.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function httpsUrl(value) {
	if (typeof value !== "string") return undefined;
	const s = value.trim();
	if (!/^https:\/\/[^\s]+$/i.test(s)) return undefined;
	let u;
	try {
		u = new URL(s);
	} catch {
		return undefined;
	}
	if (u.protocol !== "https:" || !u.hostname || u.username || u.password || u.search || u.hash || s.includes("?") || s.includes("#")) return undefined;
	return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}
