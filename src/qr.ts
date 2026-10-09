// Terminal QR code: two modules per character cell using half blocks with explicit colors,
// so it scans in both dark and light terminal themes.

import QRCode from "qrcode";

const QUIET = 2;
const FG = "\x1b[38;2;0;0;0m";
const BG = "\x1b[48;2;255;255;255m";
const RESET = "\x1b[0m";

export function qrMatrix(text: string): boolean[][] {
	const { modules } = QRCode.create(text, { errorCorrectionLevel: "L" });
	const n = modules.size;
	const size = n + QUIET * 2;
	const rows: boolean[][] = [];
	for (let r = 0; r < size; r++) {
		const row: boolean[] = [];
		for (let c = 0; c < size; c++) {
			const inside = r >= QUIET && c >= QUIET && r < n + QUIET && c < n + QUIET;
			row.push(inside && !!modules.get(r - QUIET, c - QUIET));
		}
		rows.push(row);
	}
	return rows;
}

/** Renders the QR as terminal lines; each line is `width` visible columns. */
export function qrLines(text: string): { lines: string[]; width: number } {
	const m = qrMatrix(text);
	const lines: string[] = [];
	for (let r = 0; r < m.length; r += 2) {
		let line = FG + BG;
		for (let c = 0; c < m.length; c++) {
			const top = m[r][c];
			const bottom = m[r + 1]?.[c] ?? false;
			line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
		}
		lines.push(line + RESET);
	}
	return { lines, width: m.length };
}
