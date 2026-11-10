/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/** A bad argument to the sync (unknown module, unusable destination, bad cap, a sync already running), as opposed to a failed request. */
export class SyncInputError extends Error {}
