// A pretend deploy tool that asks for confirmation, to exercise answering pi's dialogs by voice.
// pi -e ./src/index.ts -e ./test/e2e/deploy-ext.ts ; each answer is appended to $DEPLOY_LOG.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
export default function (pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: "deploy", label: "Deploy", description: "Deploy the app to an environment. Always asks the user for confirmation first.",
    parameters: Type.Object({ environment: Type.String({ description: "staging or production" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const ok = await ctx.ui.confirm(`Deploy to ${params.environment}?`, "This ships the current main branch.");
      appendFileSync(process.env.DEPLOY_LOG || "/tmp/pi-mobile-e2e-deploy.log", `${new Date().toISOString()} confirm=${ok}\n`);
      return { content: [{ type: "text", text: ok ? `Deployed to ${params.environment}.` : "Deployment cancelled by the user." }], details: {} };
    },
  }));
}
