import { settleDue } from '../../lib/jush-settlement.js';
export default {
  async scheduled(controller, env) {
    await settleDue(env.GOG_DB, true);
  },
};
