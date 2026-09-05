import { createHash } from 'node:crypto';
import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { createPublicRuntime } from '../../../public_outsource_worker/src/runtime.mjs';

export const runtime = 'nodejs';
export const maxDuration = 30;

const publicRuntime = createPublicRuntime();
const CANARY_RECORD_ID = '267a034fb6674d629db7aaacddff36b8';
const CASE_ID = 'CLAUDE-MCP-CANARY';

function asToolResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function taskSuffix(runId) {
  return createHash('sha256')
    .update(runId || 'default')
    .digest('hex')
    .slice(0, 16);
}

const handler = createMcpHandler((server) => {
  server.registerTool(
    'outsource_capabilities',
    {
      title: 'Outsource Capabilities',
      description:
        'Lists the bounded public outsource capabilities exposed by this Claude canary gateway. This is capability discovery, not canonical truth.',
      inputSchema: z.object({}),
    },
    async () =>
      asToolResult({
        schema: 'claude.outsource_capabilities.v1',
        mode: 'PUBLIC_CANARY_ONLY',
        capabilities: publicRuntime.registry.list(),
        canonical_write: false,
        arbitrary_network_access: false,
        private_data_access: false,
      }),
  );

  server.registerTool(
    'outsource_health',
    {
      title: 'Outsource Health',
      description:
        'Returns the gateway canary state and the capability registry. It does not claim background liveness beyond this request.',
      inputSchema: z.object({}),
    },
    async () =>
      asToolResult({
        schema: 'claude.outsource_health.v1',
        status: 'REQUEST_PATH_ALIVE',
        mode: 'PUBLIC_CANARY_ONLY',
        capabilities: publicRuntime.registry.list(),
        durable_scheduler_verified: false,
        canonical_write: false,
      }),
  );

  server.registerTool(
    'outsource_dispatch_canary',
    {
      title: 'Run Outsource Canary',
      description:
        'Executes the real public Cuckoo -> BUBO bounded worker chain against one fixed official Prozorro fixture. No arbitrary URL, private data, tactical data, secret access, or canonical write is possible.',
      inputSchema: z.object({
        run_id: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,48}$/)
          .optional()
          .describe('Optional idempotency label for the canary call.'),
      }),
    },
    async ({ run_id }) => {
      const suffix = taskSuffix(run_id);
      const cuckoo = await publicRuntime.dispatcher.dispatch({
        task_id: `claude.mcp.cuckoo.${suffix}`,
        case_id: CASE_ID,
        worker: 'cuckoo',
        capability: 'prozorro_snapshot_v1',
        sensitivity: 'PUBLIC',
        payload: {
          record_id: CANARY_RECORD_ID,
        },
      });

      const bubo = await publicRuntime.dispatcher.dispatch({
        task_id: `claude.mcp.bubo.${suffix}`,
        case_id: CASE_ID,
        worker: 'bubo',
        capability: 'evidence_packet_v1',
        sensitivity: 'PUBLIC',
        payload: {
          cuckoo_result: cuckoo.result,
        },
      });

      return asToolResult({
        schema: 'claude.outsource_canary_receipt.v1',
        mode: 'PUBLIC_CANARY_ONLY',
        run_id: run_id || 'default',
        worker_chain: ['cuckoo:prozorro_snapshot_v1', 'bubo:evidence_packet_v1'],
        candidate_only: true,
        canonical_admission: 'PENDING_VERIFIER',
        cuckoo,
        bubo,
      });
    },
  );
});

export { handler as GET, handler as POST };
