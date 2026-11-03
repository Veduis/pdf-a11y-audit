#!/usr/bin/env node
import { main } from '../src/mcp.js';
main().catch((err) => {
  console.error('pdf-a11y-audit MCP failed:', err && err.stack || err);
  process.exit(1);
});
