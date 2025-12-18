async function loadGobogConfig() {
  if (window.GOBOG_CONFIG) return window.GOBOG_CONFIG;

  const res = await fetch("./config.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load config.json: " + res.status);

  const cfg = await res.json();
  cfg.EXPLORER_BASE = String(cfg.EXPLORER_BASE || "https://bscscan.com").replace(/\/$/, "");
  if (cfg.TOKEN_ADDRESS) cfg.TOKEN_EXPLORER_URL = cfg.EXPLORER_BASE + "/address/" + cfg.TOKEN_ADDRESS;
  if (cfg.PRESALE_ADDRESS) cfg.PRESALE_EXPLORER_URL = cfg.EXPLORER_BASE + "/address/" + cfg.PRESALE_ADDRESS;

  window.GOBOG_CONFIG = cfg;
  return cfg;
}
window.loadGobogConfig = loadGobogConfig;
