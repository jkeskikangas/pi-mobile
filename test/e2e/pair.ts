// Prints a single-use pairing link for the hub of PI_CODING_AGENT_DIR (joins as a helper link, then leaves).
// Usage: PI_CODING_AGENT_DIR=/tmp/piagent node --experimental-strip-types test/e2e/pair.ts

const { HubLink } = await import("../../src/link.ts");
const { loadConfig, linkSecret } = await import("../../src/store.ts");
const info = () => ({ agent: "e2e-pair", pid: process.pid, sessionId: "e2e", name: "e2e pairing", cwd: process.cwd(), status: "idle" as const });
const link = new HubLink({ config: loadConfig, secret: linkSecret(), info, onRequest: async () => ({}), onMessage: () => {}, onState: () => {} } as any);
link.start();
for (let i = 0; i < 80 && !link.linked; i++) await new Promise((r) => setTimeout(r, 100));
if (!link.linked) throw new Error("no hub: start pi with pi-mobile and /remote first");
const p: any = await link.request("pair", {});
console.log(p.links.find((l: any) => l.url.includes("127.0.0.1"))?.url ?? p.links[0].url);
link.stop();
process.exit(0);
