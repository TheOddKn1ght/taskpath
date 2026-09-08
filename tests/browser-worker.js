import { sync, isUnlocked } from '/assets/e2ee-v3/offline.js';
import { rememberedKey } from '/assets/e2ee-v3/persistence.js';
try { await sync(); postMessage({ unlocked: isUnlocked(), remembered: await rememberedKey() }); }
catch (error) { postMessage({ error: error.message }); }
