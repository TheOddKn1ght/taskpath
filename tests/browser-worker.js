import { sync, isUnlocked } from '/assets/accounts-v1/offline.js';
import { rememberedKey } from '/assets/accounts-v1/persistence.js';
try { await sync(); postMessage({ unlocked: isUnlocked(), remembered: await rememberedKey() }); }
catch (error) { postMessage({ error: error.message }); }
