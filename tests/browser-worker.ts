import { sync, isUnlocked } from '/assets/accounts-v17/offline.js';
import { rememberedKey } from '/assets/accounts-v17/persistence.js';
try { await sync(); postMessage({ unlocked: isUnlocked(), remembered: await rememberedKey() }); }
catch (error) { postMessage({ error: error instanceof Error ? error.message : String(error) }); }
