#!/usr/bin/env node
'use strict';

/**
 * ARCHITECTURE-PUBLIC.md §2.3 documents this path:
 *
 *     docker exec -i frameo-signalling node tools/hash-password.js
 *
 * The implementation lives one directory up, next to the module it shares (`scrypt.js`), so
 * this file is a shim and nothing else. Both paths work; use whichever the runbook you are
 * reading mentions.
 */

require('../hash-password.js');
