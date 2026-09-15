import { sync, isUnlocked } from '/assets/__TASKPATH_RELEASE__/offline.js';
import { rememberedKey } from '/assets/__TASKPATH_RELEASE__/persistence.js';
try { await sync(); postMessage({ unlocked: isUnlocked(), remembered: await rememberedKey() }); }
catch (error) { postMessage({ error: error instanceof Error ? error.message : String(error) }); }
