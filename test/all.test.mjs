/**
 * Single-process test entry.
 *
 * `node --test test/` runs each file in a child process, which is the normal way
 * to run these. Some restricted Windows environments (including DSH's own
 * sandboxed shell) refuse piped child stdio, so this file imports the same test
 * modules into one process as a fallback:
 *
 *     node test/all.test.mjs
 */

import './unit.test.mjs'
import './actions.test.mjs'
import './client.test.mjs'
