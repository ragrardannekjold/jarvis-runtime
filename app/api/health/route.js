import { createPublicRuntime } from '../../../public_outsource_worker/src/runtime.mjs';

export const runtime = 'nodejs';

const publicRuntime = createPublicRuntime();

export async function GET() {
  return Response.json({
    schema: 'claude.outsource_gateway_health.v1',
    status: 'REQUEST_PATH_ALIVE',
    mode: 'PUBLIC_CANARY_ONLY',
    capabilities: publicRuntime.registry.list(),
    canonical_write: false,
    arbitrary_network_access: false,
    private_data_access: false,
    durable_scheduler_verified: false,
  });
}
