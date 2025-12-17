// Shared config loader. Uses config.json so you can edit without touching JS.
async function loadGobogConfig(){
  if (window.GOBOG_CONFIG) return window.GOBOG_CONFIG;

  const res = await fetch('./config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load config.json: ' + res.status);
  const cfg = await res.json();

  cfg.TOKEN_EXPLORER_URL  = cfg.EXPLORER_BASE + '/address/' + cfg.TOKEN_ADDRESS;
  cfg.PRESALE_EXPLORER_URL = cfg.EXPLORER_BASE + '/address/' + cfg.PRESALE_ADDRESS;

  window.GOBOG_CONFIG = cfg;
  return cfg;
}
