import { sync, isUnlocked } from '/assets/accounts-v4/offline.js';
import { rememberedKey } from '/assets/accounts-v4/persistence.js';
try { await sync(); postMessage({ unlocked: isUnlocked(), remembered: await rememberedKey() }); }
catch (error) { postMessage({ error: error.message }); }
