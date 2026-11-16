// Minimal plugin: one RPC method, one service-emitted event, one HTTP route.
// Plain object entry so it needs no dependencies.
let emit;

export default {
  id: "clawtrate-probe",
  name: "Clawtrate probe",
  description: "Proves a plugin can add a Gateway RPC method, an HTTP route and a broadcast event.",
  register(api) {
    api.registerService({
      id: "clawtrate-probe-events",
      start(ctx) {
        emit = ctx.gatewayEvents ? (name, payload) => ctx.gatewayEvents.emit(name, payload, { scope: "operator.read" }) : undefined;
      },
      stop() {
        emit = undefined;
      },
    });

    api.registerGatewayMethod(
      "clawtrate-probe.ping",
      ({ params, respond }) => {
        const at = Date.now();
        emit?.("pinged", { at, note: typeof params.note === "string" ? params.note.slice(0, 80) : null });
        respond(true, { pong: true, at, emitted: Boolean(emit) });
      },
      { scope: "operator.read" },
    );

    // Variable names (never values) visible inside the gateway process, after
    // OpenClaw's own .env and config loaders. Used by dev-gateway.sh check-env.
    api.registerGatewayMethod(
      "clawtrate-probe.envNames",
      ({ respond }) => respond(true, { names: Object.keys(process.env).sort() }),
      { scope: "operator.admin" },
    );

    api.registerHttpRoute({
      path: "/clawtrate-probe/health",
      auth: "gateway",
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return true;
      },
    });
  },
};
