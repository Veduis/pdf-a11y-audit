#!/usr/bin/env node
/**
 * A minimal MCP stdio client.
 *
 * It starts the local server, calls audit_pdf, and prints the result exactly as
 * the server returned it. No network access and no model call.
 *
 * Usage:
 *   node examples/mcp-client.mjs ./document.pdf
 *   node examples/mcp-client.mjs ./document.pdf json
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
const format = process.argv[3] === 'json' ? 'json' : 'markdown';

if (!file) {
  process.stderr.write('Usage: node examples/mcp-client.mjs <file.pdf> [json|markdown]\n');
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, '..', 'bin', 'mcp.js')],
  cwd: process.cwd(),
  stderr: 'pipe',
});

const client = new Client({ name: 'pdf-a11y-audit-example', version: '1.0.0' });
await client.connect(transport);
try {
  if (process.env.MCP_TRACE) {
    process.stderr.write(`[mcp] tools/call audit_pdf ${JSON.stringify({ path: file, format })}\n`);
  }
  const result = await client.callTool({
    name: 'audit_pdf',
    arguments: { path: path.resolve(process.cwd(), file), format },
  });
  process.stdout.write(`${result.content[0].text}\n`);
} finally {
  await client.close().catch(() => {});
}
