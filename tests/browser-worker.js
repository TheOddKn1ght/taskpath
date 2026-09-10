import { sync, isUnlocked } from '/assets/accounts-v11/offline.js';
import { rememberedKey } from '/assets/accounts-v11/persistence.js';
try { await sync(); postMessage({ unlocked: isUnlocked(), remembered: await rememberedKey() }); }
catch (error) { postMessage({ error: error.message }); }
