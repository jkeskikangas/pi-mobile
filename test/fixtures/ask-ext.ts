// A test extension that asks the user through pi's own dialogs, the way real extensions do:
// `/ask` runs a confirm, a select and an input and reports each answer with a notification.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ask", {
		description: "Ask three questions",
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm("Deploy to staging?", "This ships main.");
			ctx.ui.notify(`confirm=${ok}`, "info");
			const env = await ctx.ui.select("Which region?", ["eu", "us"]);
			ctx.ui.notify(`select=${env}`, "info");
			const note = await ctx.ui.input("Release note?", "one line");
			ctx.ui.notify(`input=${note}`, "info");
		},
	});
}
